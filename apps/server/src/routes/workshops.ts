import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "@cohort/db";
import { createWorkshopBody, createWorkshopIssuesBody, workshopMessageBody } from "@cohort/shared";
import { parseBody, requireUser } from "../http.ts";
import { findProject } from "../projects.ts";
import { WorkshopError, type Workshops } from "../workshops/service.ts";

interface ProjectParams {
  workspace: string;
  project: string;
}
interface WorkshopParams extends ProjectParams {
  id: string;
}

export async function workshopRoutes(app: FastifyInstance, { db, workshops }: { db: Db; workshops: Workshops }) {
  app.addHook("preHandler", requireUser);

  function project(params: ProjectParams, reply: FastifyReply) {
    const row = findProject(db, params.workspace, params.project);
    if (!row) reply.code(404).send({ error: "Project not found" });
    return row;
  }

  function workshop(params: WorkshopParams, reply: FastifyReply) {
    const p = project(params, reply);
    if (!p) return undefined;
    const row = workshops.get(Number(params.id));
    if (!row || row.projectId !== p.id) {
      reply.code(404).send({ error: "Workshop not found" });
      return undefined;
    }
    return row;
  }

  // Runs `action`, turning WorkshopError into a 409 (it's about the workshop's state).
  async function guarded<T>(reply: FastifyReply, action: () => T | Promise<T>): Promise<T | undefined> {
    try {
      return await action();
    } catch (e) {
      if (e instanceof WorkshopError) {
        reply.code(409).send({ error: e.message });
        return undefined;
      }
      throw e;
    }
  }

  const base = "/api/projects/:workspace/:project/workshops";

  app.get<{ Params: ProjectParams }>(base, async (request, reply) => {
    const p = project(request.params, reply);
    if (!p) return;
    return { workshops: workshops.list(p.id) };
  });

  app.post<{ Params: ProjectParams }>(base, async (request, reply) => {
    const p = project(request.params, reply);
    if (!p) return;
    const body = parseBody(createWorkshopBody, request.body, reply);
    if (!body) return;
    const row = await guarded(reply, () => workshops.create(p.id, request.user!, body));
    if (!row) return;
    return reply.code(201).send({ workshop: workshops.detail(row) });
  });

  app.get<{ Params: WorkshopParams }>(`${base}/:id`, async (request, reply) => {
    const row = workshop(request.params, reply);
    if (!row) return;
    return { workshop: workshops.detail(row) };
  });

  app.post<{ Params: WorkshopParams }>(`${base}/:id/messages`, async (request, reply) => {
    const row = workshop(request.params, reply);
    if (!row) return;
    const body = parseBody(workshopMessageBody, request.body, reply);
    if (!body) return;
    if (!(await guarded(reply, () => workshops.reply(row, body.body)))) return;
    return reply.code(201).send({ workshop: workshops.detail(workshops.get(row.id)!) });
  });

  app.post<{ Params: WorkshopParams }>(`${base}/:id/propose`, async (request, reply) => {
    const row = workshop(request.params, reply);
    if (!row) return;
    if (!(await guarded(reply, () => workshops.propose(row)))) return;
    return { workshop: workshops.detail(workshops.get(row.id)!) };
  });

  app.post<{ Params: WorkshopParams }>(`${base}/:id/issues`, async (request, reply) => {
    const row = workshop(request.params, reply);
    if (!row) return;
    const body = parseBody(createWorkshopIssuesBody, request.body, reply);
    if (!body) return;
    const created = await guarded(reply, () => workshops.createIssues(row, request.user!, body.issues, body.parentIssue));
    if (!created) return;
    return reply.code(201).send({ workshop: workshops.detail(workshops.get(row.id)!), created });
  });

  app.post<{ Params: WorkshopParams }>(`${base}/:id/close`, async (request, reply) => {
    const row = workshop(request.params, reply);
    if (!row) return;
    workshops.close(row);
    return { workshop: workshops.detail(workshops.get(row.id)!) };
  });
}
