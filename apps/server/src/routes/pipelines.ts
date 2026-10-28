import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "@cohort/db";
import { runPipelineBody } from "@cohort/shared";
import { parseBody, requireUser } from "../http.ts";
import { PipelineError, type Pipelines } from "../pipelines/service.ts";
import { findProject } from "../projects.ts";

interface ProjectParams {
  workspace: string;
  project: string;
}
interface PipelineParams extends ProjectParams {
  id: string;
}

export async function pipelineRoutes(app: FastifyInstance, { db, pipelines }: { db: Db; pipelines: Pipelines }) {
  app.addHook("preHandler", requireUser);

  function project(params: ProjectParams, reply: FastifyReply) {
    const row = findProject(db, params.workspace, params.project);
    if (!row) reply.code(404).send({ error: "Project not found" });
    return row;
  }

  function pipeline(params: PipelineParams, reply: FastifyReply) {
    const p = project(params, reply);
    if (!p) return undefined;
    const row = pipelines.get(Number(params.id));
    if (!row || row.projectId !== p.id) {
      reply.code(404).send({ error: "Pipeline not found" });
      return undefined;
    }
    return row;
  }

  async function guarded<T>(reply: FastifyReply, action: () => T | Promise<T>): Promise<T | undefined> {
    try {
      return await action();
    } catch (e) {
      if (e instanceof PipelineError) {
        reply.code(400).send({ error: e.message });
        return undefined;
      }
      throw e;
    }
  }

  const base = "/api/projects/:workspace/:project/pipelines";

  app.get<{ Params: ProjectParams }>(base, async (request, reply) => {
    const p = project(request.params, reply);
    if (!p) return;
    return { pipelines: pipelines.list(p.id) };
  });

  // "Run pipeline" for a branch.
  app.post<{ Params: ProjectParams }>(base, async (request, reply) => {
    const p = project(request.params, reply);
    if (!p) return;
    const body = parseBody(runPipelineBody, request.body, reply);
    if (!body) return;
    const row = await guarded(reply, () => pipelines.runForBranch(p.id, body.ref, request.user!.id));
    if (!row) return;
    return reply.code(201).send({ pipeline: pipelines.detail(row) });
  });

  app.get<{ Params: PipelineParams }>(`${base}/:id`, async (request, reply) => {
    const row = pipeline(request.params, reply);
    if (!row) return;
    return { pipeline: pipelines.detail(row) };
  });

  app.post<{ Params: PipelineParams }>(`${base}/:id/run`, async (request, reply) => {
    const row = pipeline(request.params, reply);
    if (!row) return;
    if ((await guarded(reply, () => pipelines.run(row))) === undefined && reply.sent) return;
    return { pipeline: pipelines.detail(pipelines.get(row.id)!) };
  });

  app.post<{ Params: PipelineParams }>(`${base}/:id/cancel`, async (request, reply) => {
    const row = pipeline(request.params, reply);
    if (!row) return;
    if ((await guarded(reply, () => pipelines.cancel(row))) === undefined && reply.sent) return;
    return { pipeline: pipelines.detail(pipelines.get(row.id)!) };
  });

  app.post<{ Params: PipelineParams }>(`${base}/:id/retry`, async (request, reply) => {
    const row = pipeline(request.params, reply);
    if (!row) return;
    const next = await guarded(reply, () => pipelines.retry(row, request.user!.id));
    if (!next) return;
    return reply.code(201).send({ pipeline: pipelines.detail(next) });
  });

  app.get<{ Params: { id: string } }>("/api/ci_jobs/:id", async (request, reply) => {
    const job = pipelines.getJob(Number(request.params.id));
    if (!job) return reply.code(404).send({ error: "CI job not found" });
    return { job: pipelines.jobToApi(job) };
  });

  app.get<{ Params: { id: string } }>("/api/ci_jobs/:id/log", async (request, reply) => {
    const job = pipelines.getJob(Number(request.params.id));
    if (!job) return reply.code(404).send({ error: "CI job not found" });
    return reply.type("text/plain; charset=utf-8").send(pipelines.logs.read(job.id));
  });

  // Live log over server-sent events, like agent jobs.
  app.get<{ Params: { id: string } }>("/api/ci_jobs/:id/events", async (request, reply) => {
    const job = pipelines.getJob(Number(request.params.id));
    if (!job) return reply.code(404).send({ error: "CI job not found" });
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const onLog = (text: string) => send("log", text);
    send("log", pipelines.logs.read(job.id));
    pipelines.logs.on(`log:${job.id}`, onLog);
    const keepAlive = setInterval(() => res.write(": ping\n\n"), 20_000);
    request.raw.on("close", () => {
      clearInterval(keepAlive);
      pipelines.logs.off(`log:${job.id}`, onLog);
    });
  });
}
