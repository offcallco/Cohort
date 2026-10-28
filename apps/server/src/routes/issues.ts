import type { FastifyInstance, FastifyReply } from "fastify";
import { asc, eq } from "drizzle-orm";
import { users, workspaces, type Db } from "@cohort/db";
import {
  ISSUE_STATUSES,
  createCommentBody,
  createIssueBody,
  instructionBody,
  planDecisionBody,
  splitDecisionBody,
  updateIssueBody,
  type IssueStatus,
  type User,
} from "@cohort/shared";
import {
  IssueError,
  addComment,
  createIssue,
  findIssue,
  issueDetail,
  listIssues,
  projectLabels,
  updateIssue,
  type ListFilter,
} from "../issues/service.ts";
import { parseBody, requireUser } from "../http.ts";
import { JobError, type Jobs } from "../jobs/service.ts";
import type { StoryService } from "../issues/story.ts";
import { findProject } from "../projects.ts";

interface ProjectParams {
  workspace: string;
  project: string;
}
interface IssueParams extends ProjectParams {
  number: string;
}
interface ListQuery {
  status?: string;
  label?: string;
  q?: string;
  // "me", "agents", "none", or a username.
  assignee?: string;
  workspace?: string;
}

function parseFilter(db: Db, query: ListQuery, me: User): ListFilter {
  const status =
    query.status === "open" || ISSUE_STATUSES.includes(query.status as IssueStatus)
      ? (query.status as ListFilter["status"])
      : undefined;
  let assignee: ListFilter["assignee"];
  if (query.assignee === "me") assignee = { userId: me.id };
  else if (query.assignee === "agents" || query.assignee === "none") assignee = query.assignee;
  else if (query.assignee) {
    // An unknown username matches nothing rather than everything.
    const user = db.select({ id: users.id }).from(users).where(eq(users.username, query.assignee)).get();
    assignee = { userId: user?.id ?? -1 };
  }
  return { status, label: query.label || undefined, q: query.q?.trim() || undefined, assignee };
}

// Runs a write, turning IssueError into a 400.
function guarded<T>(reply: FastifyReply, write: () => T): T | undefined {
  try {
    return write();
  } catch (e) {
    if (e instanceof IssueError) {
      reply.code(400).send({ error: e.message });
      return undefined;
    }
    throw e;
  }
}

export async function issueRoutes(app: FastifyInstance, { db, jobs, story }: { db: Db; jobs: Jobs; story: StoryService }) {
  app.addHook("preHandler", requireUser);

  // Replies 400 if `assignee` is a bot that can't work on this project yet.
  async function checkBotAssignee(projectId: number, assignee: string | null | undefined, reply: FastifyReply) {
    if (!assignee) return true;
    const user = db.select().from(users).where(eq(users.username, assignee)).get();
    if (user?.kind !== "bot") return true;
    try {
      await jobs.checkAssignable(projectId);
      return true;
    } catch (e) {
      if (!(e instanceof JobError)) throw e;
      reply.code(400).send({ error: e.message });
      return false;
    }
  }

  function project(params: ProjectParams, reply: FastifyReply) {
    const row = findProject(db, params.workspace, params.project);
    if (!row) reply.code(404).send({ error: "Project not found" });
    return row;
  }

  function issue(params: IssueParams, reply: FastifyReply) {
    const p = project(params, reply);
    if (!p) return undefined;
    const number = Number(params.number);
    const row = Number.isInteger(number) ? findIssue(db, p.id, number) : undefined;
    if (!row) reply.code(404).send({ error: "Issue not found" });
    return row;
  }

  const base = "/api/projects/:workspace/:project";

  app.get("/api/users", async () => ({
    users: db.select({ id: users.id, username: users.username, kind: users.kind }).from(users).orderBy(asc(users.username)).all(),
  }));

  // Issues from every project, optionally narrowed to one workspace.
  app.get<{ Querystring: ListQuery }>("/api/issues", async (request, reply) => {
    const filter = parseFilter(db, request.query, request.user!);
    if (request.query.workspace) {
      const w = db.select().from(workspaces).where(eq(workspaces.slug, request.query.workspace)).get();
      if (!w) return reply.code(404).send({ error: "Workspace not found" });
      return { issues: listIssues(db, { workspaceId: w.id }, filter) };
    }
    return { issues: listIssues(db, "all", filter) };
  });

  app.get<{ Params: { workspace: string }; Querystring: ListQuery }>(
    "/api/workspaces/:workspace/issues",
    async (request, reply) => {
      const w = db.select().from(workspaces).where(eq(workspaces.slug, request.params.workspace)).get();
      if (!w) return reply.code(404).send({ error: "Workspace not found" });
      return { issues: listIssues(db, { workspaceId: w.id }, parseFilter(db, request.query, request.user!)) };
    },
  );

  app.get<{ Params: ProjectParams; Querystring: ListQuery }>(`${base}/issues`, async (request, reply) => {
    const p = project(request.params, reply);
    if (!p) return;
    return { issues: listIssues(db, { projectId: p.id }, parseFilter(db, request.query, request.user!)) };
  });

  app.get<{ Params: ProjectParams }>(`${base}/labels`, async (request, reply) => {
    const p = project(request.params, reply);
    if (!p) return;
    return { labels: projectLabels(db, p.id) };
  });

  app.post<{ Params: ProjectParams }>(`${base}/issues`, async (request, reply) => {
    const p = project(request.params, reply);
    if (!p) return;
    const body = parseBody(createIssueBody, request.body, reply);
    if (!body) return;
    if (!(await checkBotAssignee(p.id, body.assignee, reply))) return;
    const row = guarded(reply, () => createIssue(db, p.id, request.user!.id, body));
    if (!row) return;
    await jobs.assigneeChanged(row, null);
    return reply.code(201).send({ issue: issueDetail(db, findIssue(db, p.id, row.number)!) });
  });

  app.get<{ Params: IssueParams }>(`${base}/issues/:number`, async (request, reply) => {
    const row = issue(request.params, reply);
    if (!row) return;
    return { issue: issueDetail(db, row) };
  });

  // Everything the work item page shows, in one request.
  app.get<{ Params: IssueParams }>(`${base}/issues/:number/story`, async (request, reply) => {
    const row = issue(request.params, reply);
    if (!row) return;
    return { story: await story.story(row) };
  });

  app.patch<{ Params: IssueParams }>(`${base}/issues/:number`, async (request, reply) => {
    const row = issue(request.params, reply);
    if (!row) return;
    const body = parseBody(updateIssueBody, request.body, reply);
    if (!body) return;
    if (!(await checkBotAssignee(row.projectId, body.assignee, reply))) return;
    const updated = guarded(reply, () => updateIssue(db, row, body));
    if (!updated) return;
    await jobs.assigneeChanged(updated, row.assigneeId);
    if (updated.status === "done" && row.status !== "done") await jobs.flow.issueDone(updated);
    return { issue: issueDetail(db, findIssue(db, row.projectId, row.number)!) };
  });

  // Human gate actions. Each runs, then returns the updated issue.
  const gate = async (reply: FastifyReply, row: { projectId: number; number: number }, action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (e) {
      if (e instanceof JobError) return reply.code(400).send({ error: e.message });
      throw e;
    }
    return { issue: issueDetail(db, findIssue(db, row.projectId, row.number)!) };
  };

  app.post<{ Params: IssueParams }>(`${base}/issues/:number/plan`, async (request, reply) => {
    const row = issue(request.params, reply);
    if (!row) return;
    const body = parseBody(planDecisionBody, request.body, reply);
    if (!body) return;
    return gate(reply, row, () => jobs.flow.decidePlan(row, body.decision, body.note, request.user!.id));
  });

  app.post<{ Params: IssueParams }>(`${base}/issues/:number/request-changes`, async (request, reply) => {
    const row = issue(request.params, reply);
    if (!row) return;
    const body = parseBody(instructionBody, request.body, reply);
    if (!body) return;
    return gate(reply, row, () => jobs.flow.requestChanges(row, body.note, request.user!.id));
  });

  app.post<{ Params: IssueParams }>(`${base}/issues/:number/redirect`, async (request, reply) => {
    const row = issue(request.params, reply);
    if (!row) return;
    const body = parseBody(instructionBody, request.body, reply);
    if (!body) return;
    return gate(reply, row, () => jobs.flow.redirect(row, body.note, request.user!.id));
  });

  // Approve (or decline) a split that was over the runner's limit.
  app.post<{ Params: IssueParams }>(`${base}/issues/:number/split`, async (request, reply) => {
    const row = issue(request.params, reply);
    if (!row) return;
    const body = parseBody(splitDecisionBody, request.body, reply);
    if (!body) return;
    try {
      await jobs.flow.decideSplit(row, body.approve);
    } catch (e) {
      if (e instanceof JobError) return reply.code(400).send({ error: e.message });
      throw e;
    }
    return { issue: issueDetail(db, findIssue(db, row.projectId, row.number)!) };
  });

  app.post<{ Params: IssueParams }>(`${base}/issues/:number/comments`, async (request, reply) => {
    const row = issue(request.params, reply);
    if (!row) return;
    const body = parseBody(createCommentBody, request.body, reply);
    if (!body) return;
    addComment(db, row, request.user!.id, body.body);
    return reply.code(201).send({ issue: issueDetail(db, findIssue(db, row.projectId, row.number)!) });
  });
}
