import type { FastifyInstance, FastifyReply } from "fastify";
import { asc, eq } from "drizzle-orm";
import { users, workspaces, type Db } from "@cohort/db";
import {
  ISSUE_STATUSES,
  createCommentBody,
  createIssueBody,
  updateIssueBody,
  type IssueStatus,
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
}

function parseFilter(query: ListQuery): ListFilter {
  const status =
    query.status === "open" || ISSUE_STATUSES.includes(query.status as IssueStatus)
      ? (query.status as ListFilter["status"])
      : undefined;
  return { status, label: query.label || undefined, q: query.q?.trim() || undefined };
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

export async function issueRoutes(app: FastifyInstance, { db }: { db: Db }) {
  app.addHook("preHandler", requireUser);

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
    users: db.select({ id: users.id, username: users.username }).from(users).orderBy(asc(users.username)).all(),
  }));

  app.get<{ Params: { workspace: string }; Querystring: ListQuery }>(
    "/api/workspaces/:workspace/issues",
    async (request, reply) => {
      const w = db.select().from(workspaces).where(eq(workspaces.slug, request.params.workspace)).get();
      if (!w) return reply.code(404).send({ error: "Workspace not found" });
      return { issues: listIssues(db, { workspaceId: w.id }, parseFilter(request.query)) };
    },
  );

  app.get<{ Params: ProjectParams; Querystring: ListQuery }>(`${base}/issues`, async (request, reply) => {
    const p = project(request.params, reply);
    if (!p) return;
    return { issues: listIssues(db, { projectId: p.id }, parseFilter(request.query)) };
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
    const row = guarded(reply, () => createIssue(db, p.id, request.user!.id, body));
    if (!row) return;
    return reply.code(201).send({ issue: issueDetail(db, row) });
  });

  app.get<{ Params: IssueParams }>(`${base}/issues/:number`, async (request, reply) => {
    const row = issue(request.params, reply);
    if (!row) return;
    return { issue: issueDetail(db, row) };
  });

  app.patch<{ Params: IssueParams }>(`${base}/issues/:number`, async (request, reply) => {
    const row = issue(request.params, reply);
    if (!row) return;
    const body = parseBody(updateIssueBody, request.body, reply);
    if (!body) return;
    const updated = guarded(reply, () => updateIssue(db, row, body));
    if (!updated) return;
    return { issue: issueDetail(db, updated) };
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
