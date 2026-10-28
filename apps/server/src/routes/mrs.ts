import type { FastifyInstance, FastifyReply } from "fastify";
import { desc, eq } from "drizzle-orm";
import { issues, pipelines as pipelinesTable, projects, workspaces, type Db } from "@cohort/db";
import {
  createCommentBody,
  createMergeRequestBody,
  mergeBody,
  type MergeRequestStatus,
} from "@cohort/shared";
import { branchSha, MergeConflictError, GitError, repoDir } from "../git/repo.ts";
import { parseBody, requireUser } from "../http.ts";
import type { Jobs } from "../jobs/service.ts";
import type { Pipelines } from "../pipelines/service.ts";
import {
  addMergeRequestComment,
  createMergeRequest,
  findMergeRequest,
  listMergeRequests,
  mergeMergeRequest,
  mergeRequestDetail,
  setMergeRequestStatus,
} from "../mrs/service.ts";
import { findProject } from "../projects.ts";

interface ProjectParams {
  workspace: string;
  project: string;
}
interface MrParams extends ProjectParams {
  number: string;
}

export async function mergeRequestRoutes(
  app: FastifyInstance,
  { db, reposRoot, jobs, pipelines }: { db: Db; reposRoot: string; jobs: Jobs; pipelines: Pipelines },
) {
  app.addHook("preHandler", requireUser);

  function project(params: ProjectParams, reply: FastifyReply) {
    const row = findProject(db, params.workspace, params.project);
    if (!row) reply.code(404).send({ error: "Project not found" });
    return row;
  }

  function mr(params: MrParams, reply: FastifyReply) {
    const p = project(params, reply);
    if (!p) return undefined;
    const row = findMergeRequest(db, p.id, Number(params.number));
    if (!row) reply.code(404).send({ error: "Merge request not found" });
    return row;
  }

  // The pipeline shown on a merge request: the newest one for the source branch's current
  // commit (or, once merged, for the commit that was merged).
  async function pipelineFor(row: NonNullable<ReturnType<typeof findMergeRequest>>) {
    const gitDir = repoDir(reposRoot, ...projectSlugs(row.projectId));
    const sha = row.status === "merged" && row.mergeSha ? null : await branchSha(gitDir, row.sourceBranch);
    const p = sha
      ? pipelines.latestFor(row.projectId, row.sourceBranch, sha)
      : db.select().from(pipelinesTable).where(eq(pipelinesTable.mergeRequestId, row.id)).orderBy(desc(pipelinesTable.id)).get();
    return p ? pipelines.summary(p) : null;
  }

  function projectSlugs(projectId: number): [string, string] {
    const r = db
      .select({ w: workspaces.slug, p: projects.slug })
      .from(projects)
      .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
      .where(eq(projects.id, projectId))
      .get()!;
    return [r.w, r.p];
  }

  const detail = async (row: NonNullable<ReturnType<typeof findMergeRequest>>) => ({
    mergeRequest: {
      ...(await mergeRequestDetail(db, reposRoot, row)),
      jobs: jobs.list({ mergeRequestId: row.id }),
      pipeline: await pipelineFor(row),
      pipelinesMustSucceed: db.select().from(projects).where(eq(projects.id, row.projectId)).get()!.pipelinesMustSucceed,
    },
  });

  const base = "/api/projects/:workspace/:project/merge_requests";

  app.get<{ Params: ProjectParams; Querystring: { status?: string } }>(base, async (request, reply) => {
    const p = project(request.params, reply);
    if (!p) return;
    const status = ["open", "merged", "closed"].includes(request.query.status ?? "")
      ? (request.query.status as MergeRequestStatus)
      : undefined;
    return { mergeRequests: listMergeRequests(db, p.id, status) };
  });

  app.post<{ Params: ProjectParams }>(base, async (request, reply) => {
    const p = project(request.params, reply);
    if (!p) return;
    const body = parseBody(createMergeRequestBody, request.body, reply);
    if (!body) return;
    const gitDir = repoDir(reposRoot, request.params.workspace, request.params.project);
    for (const branch of [body.sourceBranch, body.targetBranch]) {
      if (!(await branchSha(gitDir, branch))) return reply.code(400).send({ error: `Branch "${branch}" not found` });
    }
    if (body.sourceBranch === body.targetBranch) {
      return reply.code(400).send({ error: "Source and target must be different branches" });
    }
    const row = createMergeRequest(db, { projectId: p.id, authorId: request.user!.id, ...body });
    await pipelines.forMergeRequest(row);
    return reply.code(201).send(await detail(row));
  });

  app.get<{ Params: MrParams }>(`${base}/:number`, async (request, reply) => {
    const row = mr(request.params, reply);
    if (!row) return;
    return detail(row);
  });

  app.post<{ Params: MrParams }>(`${base}/:number/merge`, async (request, reply) => {
    const row = mr(request.params, reply);
    if (!row) return;
    if (row.status !== "open") return reply.code(400).send({ error: "Only open merge requests can be merged" });
    const body = parseBody(mergeBody, request.body, reply);
    if (!body) return;
    const project = db.select().from(projects).where(eq(projects.id, row.projectId)).get()!;
    if (project.pipelinesMustSucceed) {
      const pipeline = await pipelineFor(row);
      if (pipeline?.status !== "success") {
        return reply.code(409).send({ error: pipeline ? `The pipeline must succeed first (it's ${pipeline.status})` : "This project needs a passing pipeline before merging" });
      }
    }
    try {
      const merged = await mergeMergeRequest(db, reposRoot, row, request.user!, body.deleteSourceBranch);
      // Unblock issues that waited on this one, and finish its parent.
      const issue = merged.issueId ? db.select().from(issues).where(eq(issues.id, merged.issueId)).get() : undefined;
      if (issue) await jobs.flow.issueDone(issue);
      // Merging is a push to the target branch by a person.
      if (merged.mergeSha) {
        await pipelines.create(merged.projectId, merged.targetBranch, merged.mergeSha, { source: "push", triggeredById: request.user!.id, trusted: true });
      }
      return detail(merged);
    } catch (e) {
      if (e instanceof MergeConflictError) return reply.code(409).send({ error: e.message });
      if (e instanceof GitError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  for (const [action, status] of [
    ["close", "closed"],
    ["reopen", "open"],
  ] as const) {
    app.post<{ Params: MrParams }>(`${base}/:number/${action}`, async (request, reply) => {
      const row = mr(request.params, reply);
      if (!row) return;
      if (row.status === "merged") return reply.code(400).send({ error: "This merge request is already merged" });
      return detail(setMergeRequestStatus(db, row, status));
    });
  }

  app.post<{ Params: MrParams }>(`${base}/:number/comments`, async (request, reply) => {
    const row = mr(request.params, reply);
    if (!row) return;
    const body = parseBody(createCommentBody, request.body, reply);
    if (!body) return;
    addMergeRequestComment(db, row, request.user!.id, body.body);
    return reply.code(201).send(await detail(findMergeRequest(db, row.projectId, row.number)!));
  });
}
