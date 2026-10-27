import type { FastifyInstance, FastifyReply } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import { projects, workspaces, type Db } from "@cohort/db";
import {
  createProjectBody,
  createWorkspaceBody,
  type Project,
  type Workspace,
  type WorkspaceWithProjects,
} from "@cohort/shared";
import { commitReadme, defaultBranch, initBare, repoDir } from "../git/repo.ts";
import { parseBody, requireUser } from "../http.ts";

type WorkspaceRow = typeof workspaces.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;

const workspaceToApi = (w: WorkspaceRow): Workspace => ({
  id: w.id,
  slug: w.slug,
  name: w.name,
  description: w.description,
  createdAt: w.createdAt.toISOString(),
});

export async function projectToApi(reposRoot: string, workspace: string, p: ProjectRow): Promise<Project> {
  return {
    id: p.id,
    workspace,
    slug: p.slug,
    name: p.name,
    description: p.description,
    createdAt: p.createdAt.toISOString(),
    clonePath: `/${workspace}/${p.slug}.git`,
    defaultBranch: await defaultBranch(repoDir(reposRoot, workspace, p.slug)),
    runnerContext: p.runnerContext,
  };
}

const isUniqueViolation = (e: unknown) =>
  e instanceof Error && "code" in e && e.code === "SQLITE_CONSTRAINT_UNIQUE";

export async function workspaceRoutes(
  app: FastifyInstance,
  { db, reposRoot }: { db: Db; reposRoot: string },
) {
  app.addHook("preHandler", requireUser);

  async function withProjects(w: WorkspaceRow): Promise<WorkspaceWithProjects> {
    const rows = db
      .select()
      .from(projects)
      .where(eq(projects.workspaceId, w.id))
      .orderBy(asc(projects.name))
      .all();
    return {
      ...workspaceToApi(w),
      projects: await Promise.all(rows.map((p) => projectToApi(reposRoot, w.slug, p))),
    };
  }

  function findWorkspace(slug: string, reply: FastifyReply) {
    const w = db.select().from(workspaces).where(eq(workspaces.slug, slug)).get();
    if (!w) reply.code(404).send({ error: "Workspace not found" });
    return w;
  }

  app.get("/api/workspaces", async () => {
    const rows = db.select().from(workspaces).orderBy(asc(workspaces.name)).all();
    return { workspaces: await Promise.all(rows.map(withProjects)) };
  });

  app.post("/api/workspaces", async (request, reply) => {
    const body = parseBody(createWorkspaceBody, request.body, reply);
    if (!body) return;
    try {
      const row = db.insert(workspaces).values(body).returning().get();
      return reply.code(201).send({ workspace: workspaceToApi(row) });
    } catch (e) {
      if (isUniqueViolation(e)) return reply.code(409).send({ error: "That URL is already taken" });
      throw e;
    }
  });

  app.get<{ Params: { workspace: string } }>("/api/workspaces/:workspace", async (request, reply) => {
    const w = findWorkspace(request.params.workspace, reply);
    if (!w) return;
    return { workspace: await withProjects(w) };
  });

  app.post<{ Params: { workspace: string } }>(
    "/api/workspaces/:workspace/projects",
    async (request, reply) => {
      const w = findWorkspace(request.params.workspace, reply);
      if (!w) return;
      const body = parseBody(createProjectBody, request.body, reply);
      if (!body) return;
      const taken = db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.workspaceId, w.id), eq(projects.slug, body.slug)))
        .get();
      if (taken) return reply.code(409).send({ error: "That URL is already taken in this workspace" });

      const gitDir = repoDir(reposRoot, w.slug, body.slug);
      await initBare(gitDir);
      if (body.initReadme) {
        const readme = `# ${body.name}\n${body.description ? `\n${body.description}\n` : ""}`;
        const username = request.user!.username;
        await commitReadme(gitDir, readme, { name: username, email: `${username}@cohort.local` });
      }
      const row = db
        .insert(projects)
        .values({ workspaceId: w.id, slug: body.slug, name: body.name, description: body.description })
        .returning()
        .get();
      return reply.code(201).send({ project: await projectToApi(reposRoot, w.slug, row) });
    },
  );
}
