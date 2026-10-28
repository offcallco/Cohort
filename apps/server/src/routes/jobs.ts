import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "@cohort/db";
import type { Job } from "@cohort/shared";
import { requireUser } from "../http.ts";
import { findIssue } from "../issues/service.ts";
import { JobError, type Jobs } from "../jobs/service.ts";
import { findProject } from "../projects.ts";
import type { MissionService } from "../mission.ts";

interface ProjectParams {
  workspace: string;
  project: string;
}

export async function jobRoutes(app: FastifyInstance, { db, jobs, mission }: { db: Db; jobs: Jobs; mission: MissionService }) {
  app.addHook("preHandler", requireUser);

  function job(id: string, reply: FastifyReply) {
    const row = jobs.get(Number(id));
    if (!row) reply.code(404).send({ error: "Job not found" });
    return row;
  }

  app.get<{ Params: ProjectParams }>("/api/projects/:workspace/:project/jobs", async (request, reply) => {
    const p = findProject(db, request.params.workspace, request.params.project);
    if (!p) return reply.code(404).send({ error: "Project not found" });
    return { jobs: jobs.list({ projectId: p.id }) };
  });

  app.get<{ Params: ProjectParams & { number: string } }>(
    "/api/projects/:workspace/:project/issues/:number/jobs",
    async (request, reply) => {
      const p = findProject(db, request.params.workspace, request.params.project);
      const issue = p ? findIssue(db, p.id, Number(request.params.number)) : undefined;
      if (!issue) return reply.code(404).send({ error: "Issue not found" });
      return { jobs: jobs.list({ issueId: issue.id }) };
    },
  );

  // Agent runs from every project, newest first.
  app.get<{ Querystring: { limit?: string } }>("/api/jobs", async (request) => ({
    jobs: jobs.list({}, Math.min(200, Number(request.query.limit) || 100)),
  }));

  app.get<{ Params: { id: string } }>("/api/jobs/:id/summary", async (request, reply) => {
    const row = job(request.params.id, reply);
    if (!row) return;
    return { run: mission.runSummary(row) };
  });

  for (const action of ["pause", "resume"] as const) {
    app.post<{ Params: { id: string } }>(`/api/jobs/:id/${action}`, async (request, reply) => {
      const row = job(request.params.id, reply);
      if (!row) return;
      try {
        jobs.pause(row, action === "pause");
      } catch (e) {
        if (e instanceof JobError) return reply.code(400).send({ error: e.message });
        throw e;
      }
      return { job: jobs.toApi(jobs.get(row.id)!) };
    });
  }

  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (request, reply) => {
    const row = job(request.params.id, reply);
    if (!row) return;
    return { job: jobs.toApi(row) };
  });

  app.get<{ Params: { id: string } }>("/api/jobs/:id/log", async (request, reply) => {
    const row = job(request.params.id, reply);
    if (!row) return;
    return reply.type("text/plain; charset=utf-8").send(jobs.logs.read(row.id));
  });

  // Server-sent events: one "log" event with the log so far, then "log" for each new chunk
  // and "status" whenever the job changes.
  app.get<{ Params: { id: string } }>("/api/jobs/:id/events", async (request, reply) => {
    const row = job(request.params.id, reply);
    if (!row) return;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const onLog = (text: string) => send("log", text);
    const onStatus = (status: Job) => send("status", status);
    send("log", jobs.logs.read(row.id));
    send("status", jobs.toApi(row));
    jobs.logs.on(`log:${row.id}`, onLog);
    jobs.logs.on(`status:${row.id}`, onStatus);
    const keepAlive = setInterval(() => res.write(": ping\n\n"), 20_000);
    request.raw.on("close", () => {
      clearInterval(keepAlive);
      jobs.logs.off(`log:${row.id}`, onLog);
      jobs.logs.off(`status:${row.id}`, onStatus);
    });
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/cancel", async (request, reply) => {
    const row = job(request.params.id, reply);
    if (!row) return;
    jobs.cancel(row);
    return { job: jobs.toApi(jobs.get(row.id)!) };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/retry", async (request, reply) => {
    const row = job(request.params.id, reply);
    if (!row) return;
    try {
      const next = await jobs.retry(row);
      return reply.code(201).send({ job: jobs.toApi(next) });
    } catch (e) {
      if (e instanceof JobError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });
}
