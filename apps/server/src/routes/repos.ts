import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { projects, type Db } from "@cohort/db";
import { updateProjectBody } from "@cohort/shared";
import {
  blob,
  branches,
  cleanPath,
  commitDetail,
  log,
  repoDir,
  resolveCommit,
  tree,
} from "../git/repo.ts";
import { parseBody, requireUser } from "../http.ts";
import { findProject } from "../projects.ts";
import { projectToApi } from "./workspaces.ts";

interface Params {
  workspace: string;
  project: string;
}
interface Query {
  ref?: string;
  path?: string;
  page?: string;
}
type Req = FastifyRequest<{ Params: Params; Querystring: Query }>;

const PAGE_SIZE = 30;
const README = /^readme(\.(md|markdown|txt))?$/i;

export async function repoRoutes(app: FastifyInstance, { db, reposRoot }: { db: Db; reposRoot: string }) {
  app.addHook("preHandler", requireUser);

  async function load(request: Req, reply: FastifyReply) {
    const { workspace, project } = request.params;
    const row = findProject(db, workspace, project);
    if (!row) {
      reply.code(404).send({ error: "Project not found" });
      return null;
    }
    const gitDir = repoDir(reposRoot, workspace, project);
    return { gitDir, project: await projectToApi(reposRoot, workspace, row) };
  }

  // Resolves ?ref= (default branch when omitted) and ?path=, replying 404/400 on failure.
  async function target(request: Req, reply: FastifyReply) {
    const loaded = await load(request, reply);
    if (!loaded) return null;
    const ref = request.query.ref || loaded.project.defaultBranch;
    const path = cleanPath(request.query.path);
    if (path === null) {
      reply.code(400).send({ error: "Invalid path" });
      return null;
    }
    const sha = ref ? await resolveCommit(loaded.gitDir, ref) : null;
    if (!ref || !sha) {
      reply.code(404).send({ error: ref ? `Unknown ref "${ref}"` : "This repository is empty" });
      return null;
    }
    return { ...loaded, ref, sha, path };
  }

  const base = "/api/projects/:workspace/:project";

  app.get<{ Params: Params; Querystring: Query }>(base, async (request, reply) => {
    const loaded = await load(request, reply);
    if (!loaded) return;
    return { project: loaded.project, branches: await branches(loaded.gitDir) };
  });

  app.patch<{ Params: Params }>(base, async (request, reply) => {
    const loaded = await load(request as Req, reply);
    if (!loaded) return;
    const body = parseBody(updateProjectBody, request.body, reply);
    if (!body) return;
    db.update(projects).set(body).where(eq(projects.id, loaded.project.id)).run();
    const row = findProject(db, request.params.workspace, request.params.project)!;
    return { project: await projectToApi(reposRoot, request.params.workspace, row) };
  });

  app.get<{ Params: Params; Querystring: Query }>(`${base}/tree`, async (request, reply) => {
    const t = await target(request, reply);
    if (!t) return;
    const entries = await tree(t.gitDir, t.sha, t.path);
    if (!entries) return reply.code(404).send({ error: "Folder not found" });
    const readmeEntry = entries.find((e) => e.type === "blob" && README.test(e.name));
    const readme = readmeEntry ? await blob(t.gitDir, t.sha, readmeEntry.path) : null;
    return { ref: t.ref, sha: t.sha, path: t.path, entries, readme };
  });

  app.get<{ Params: Params; Querystring: Query }>(`${base}/blob`, async (request, reply) => {
    const t = await target(request, reply);
    if (!t) return;
    const file = t.path ? await blob(t.gitDir, t.sha, t.path) : null;
    if (!file) return reply.code(404).send({ error: "File not found" });
    return { ref: t.ref, sha: t.sha, blob: file };
  });

  app.get<{ Params: Params; Querystring: Query }>(`${base}/commits`, async (request, reply) => {
    const t = await target(request, reply);
    if (!t) return;
    const page = Math.max(1, Number.parseInt(request.query.page ?? "1", 10) || 1);
    const result = await log(t.gitDir, t.sha, { path: t.path, skip: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE });
    return { ref: t.ref, page, ...result };
  });

  app.get<{ Params: Params & { sha: string }; Querystring: Query }>(
    `${base}/commits/:sha`,
    async (request, reply) => {
      const loaded = await load(request, reply);
      if (!loaded) return;
      const sha = /^[0-9a-f]{4,64}$/.test(request.params.sha)
        ? await resolveCommit(loaded.gitDir, request.params.sha)
        : null;
      if (!sha) return reply.code(404).send({ error: "Commit not found" });
      return { commit: await commitDetail(loaded.gitDir, sha) };
    },
  );
}
