import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import {
  issueComments,
  issues,
  jobs,
  mergeRequestComments,
  mergeRequests,
  pipelines,
  projects,
  users,
  workshops,
  workspaces,
  type Db,
} from "@cohort/db";
import type { ActivityEntry } from "@cohort/shared";
import { requireUser } from "../http.ts";

const PER_SOURCE = 200;

// Who or what changed what, newest first. Built from the records Cohort already keeps.
export async function activityRoutes(app: FastifyInstance, { db }: { db: Db }) {
  app.addHook("preHandler", requireUser);

  app.get<{ Querystring: { actor?: string; project?: string; limit?: string } }>("/api/activity", async (request) => {
    const people = new Map(db.select().from(users).all().map((u) => [u.id, u]));
    const paths = new Map(
      db
        .select({ id: projects.id, path: workspaces.slug, slug: projects.slug })
        .from(projects)
        .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
        .all()
        .map((p) => [p.id, `${p.path}/${p.slug}`]),
    );
    const issueById = new Map(db.select().from(issues).all().map((i) => [i.id, i]));
    const mrById = new Map(db.select().from(mergeRequests).all().map((m) => [m.id, m]));
    const entries: ActivityEntry[] = [];
    const push = (at: Date | null, userId: number | null, projectId: number, text: string, href: string | null) => {
      if (!at) return;
      const u = userId !== null ? people.get(userId) : undefined;
      entries.push({ at: at.toISOString(), actor: u?.username ?? "someone", bot: u?.kind === "bot", project: paths.get(projectId) ?? "", text, href });
    };
    const issueHref = (i: { projectId: number; number: number }) => `/${paths.get(i.projectId)}/issues/${i.number}`;

    for (const i of db.select().from(issues).orderBy(desc(issues.createdAt)).limit(PER_SOURCE).all()) {
      push(i.createdAt, i.authorId, i.projectId, `opened #${i.number} ${i.title}`, issueHref(i));
    }
    for (const c of db.select().from(issueComments).orderBy(desc(issueComments.createdAt)).limit(PER_SOURCE).all()) {
      const i = issueById.get(c.issueId);
      if (i) push(c.createdAt, c.authorId, i.projectId, `commented on #${i.number}: ${c.body.split("\n")[0]!.slice(0, 120)}`, issueHref(i));
    }
    for (const j of db.select().from(jobs).orderBy(desc(jobs.createdAt)).limit(PER_SOURCE).all()) {
      const i = j.issueId ? issueById.get(j.issueId) : undefined;
      const what = { implement: "coding", split: "planning", resolve: "resolving a conflict on", workshop: "a workshop turn" }[j.kind];
      const target = i ? ` #${i.number} ${i.title}` : j.workshopId ? ` (workshop #${j.workshopId})` : "";
      const href = `/${paths.get(j.projectId)}/jobs/${j.id}`;
      push(j.startedAt, j.botId, j.projectId, `started ${what}${target}`, href);
      if (j.status === "failed") push(j.finishedAt, j.botId, j.projectId, `failed ${what}${target}: ${j.error ?? "stopped"}`, href);
      if (j.status === "canceled") push(j.finishedAt, j.botId, j.projectId, `was stopped while ${what}${target}`, href);
    }
    for (const m of mrById.values()) {
      const href = `/${paths.get(m.projectId)}/merge_requests/${m.number}`;
      push(m.createdAt, m.authorId, m.projectId, `opened !${m.number} ${m.title}`, href);
      if (m.status === "merged") push(m.mergedAt, m.mergedById, m.projectId, `merged !${m.number} into ${m.targetBranch}`, href);
    }
    for (const c of db.select().from(mergeRequestComments).orderBy(desc(mergeRequestComments.createdAt)).limit(PER_SOURCE).all()) {
      const m = mrById.get(c.mergeRequestId);
      if (m) push(c.createdAt, c.authorId, m.projectId, `commented on !${m.number}${c.path ? ` (${c.path}:${c.line})` : ""}: ${c.body.split("\n")[0]!.slice(0, 120)}`, `/${paths.get(m.projectId)}/merge_requests/${m.number}`);
    }
    for (const p of db.select().from(pipelines).orderBy(desc(pipelines.createdAt)).limit(PER_SOURCE).all()) {
      if (p.finishedAt && p.status !== "manual") {
        push(p.finishedAt, p.triggeredById, p.projectId, `pipeline #${p.id} on ${p.ref} ${p.status === "success" ? "passed" : p.status}`, `/${paths.get(p.projectId)}/pipelines/${p.id}`);
      }
    }
    for (const w of db.select().from(workshops).orderBy(desc(workshops.createdAt)).limit(PER_SOURCE).all()) {
      push(w.createdAt, w.createdById, w.projectId, `started workshop #${w.id} ${w.title}`, `/${paths.get(w.projectId)}/workshops/${w.id}`);
    }

    const { actor, project } = request.query;
    const limit = Math.min(500, Number(request.query.limit) || 100);
    return {
      entries: entries
        .filter((e) => (actor === "agents" ? e.bot : actor === "people" ? !e.bot : true))
        .filter((e) => !project || e.project === project)
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, limit),
    };
  });
}
