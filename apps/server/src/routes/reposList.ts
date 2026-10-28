import type { FastifyInstance } from "fastify";
import { and, asc, count, desc, eq, inArray, ne } from "drizzle-orm";
import { issues, jobs, mergeRequests, pipelines, projects, workspaces, type Db } from "@cohort/db";
import type { RepoSummary } from "@cohort/shared";
import { defaultBranch, log, repoDir, resolveCommit } from "../git/repo.ts";
import { requireUser } from "../http.ts";

// Every repo with its health: last commit, open work, running agents, main's pipeline.
export async function reposListRoutes(app: FastifyInstance, { db, reposRoot }: { db: Db; reposRoot: string }) {
  app.addHook("preHandler", requireUser);

  app.get("/api/repos", async (): Promise<{ repos: RepoSummary[] }> => {
    const rows = db
      .select({ project: projects, workspace: workspaces.slug })
      .from(projects)
      .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
      .orderBy(asc(workspaces.slug), asc(projects.slug))
      .all();
    const counts = (query: { projectId: number; n: number }[]) => new Map(query.map((r) => [r.projectId, r.n]));
    const openIssues = counts(db.select({ projectId: issues.projectId, n: count() }).from(issues).where(ne(issues.status, "done")).groupBy(issues.projectId).all());
    const openMrs = counts(db.select({ projectId: mergeRequests.projectId, n: count() }).from(mergeRequests).where(eq(mergeRequests.status, "open")).groupBy(mergeRequests.projectId).all());
    const running = counts(db.select({ projectId: jobs.projectId, n: count() }).from(jobs).where(inArray(jobs.status, ["queued", "running"])).groupBy(jobs.projectId).all());

    const repos = await Promise.all(
      rows.map(async ({ project, workspace }) => {
        const gitDir = repoDir(reposRoot, workspace, project.slug);
        const main = await defaultBranch(gitDir);
        let lastCommit: RepoSummary["lastCommit"] = null;
        if (main) {
          const sha = await resolveCommit(gitDir, main);
          const [latest] = sha ? (await log(gitDir, sha, { path: "", skip: 0, limit: 1 })).commits : [];
          if (latest) lastCommit = { subject: latest.subject, date: latest.date, author: latest.authorName };
        }
        const pipeline = main
          ? db.select({ status: pipelines.status }).from(pipelines).where(and(eq(pipelines.projectId, project.id), eq(pipelines.ref, main))).orderBy(desc(pipelines.id)).get()
          : undefined;
        return {
          workspace,
          slug: project.slug,
          name: project.name,
          description: project.description,
          defaultBranch: main,
          lastCommit,
          openIssues: openIssues.get(project.id) ?? 0,
          openMergeRequests: openMrs.get(project.id) ?? 0,
          runningJobs: running.get(project.id) ?? 0,
          pipeline: pipeline?.status ?? null,
        };
      }),
    );
    return { repos };
  });
}
