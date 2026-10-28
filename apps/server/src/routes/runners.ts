import type { FastifyInstance, FastifyRequest } from "fastify";
import type {} from "@fastify/websocket";
import { asc, eq } from "drizzle-orm";
import { runners, users, type Db } from "@cohort/db";
import { createRunnerBody, type Bot, type Runner } from "@cohort/shared";
import { randomToken, sha256 } from "../auth.ts";
import { parseBody, requireUser } from "../http.ts";
import { RUNNER_TOKEN_PREFIX, runnerForToken, type RunnerHub } from "../runners/hub.ts";

type RunnerRow = typeof runners.$inferSelect;
type RunnerRequest = FastifyRequest & { runner?: RunnerRow };

export function createRunner(db: Db, name: string) {
  const token = RUNNER_TOKEN_PREFIX + randomToken();
  const row = db
    .insert(runners)
    .values({ name, tokenHash: sha256(token), prefix: token.slice(0, 18) })
    .returning()
    .get();
  return { row, token };
}

export async function runnerRoutes(app: FastifyInstance, { db, hub }: { db: Db; hub: RunnerHub }) {
  const toApi = (r: RunnerRow): Runner => {
    const live = hub.info(r.id);
    return {
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      online: live !== null,
      agents: live?.agents ?? [],
      concurrent: live?.concurrent ?? null,
      runningJobs: live?.running ?? 0,
      ci: live?.ci ?? false,
      lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    };
  };

  // Runners connect here with their runner token.
  app.get(
    "/api/runners/connect",
    {
      websocket: true,
      preValidation: async (request: RunnerRequest, reply) => {
        const token = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
        const runner = token ? runnerForToken(db, token) : null;
        if (!runner) return reply.code(401).send({ error: "Invalid runner token" });
        request.runner = runner;
      },
    },
    (socket, request: RunnerRequest) => hub.attach(socket, request.runner!),
  );

  await app.register(async (authed) => {
    authed.addHook("preHandler", requireUser);

    authed.get("/api/runners", async () => ({
      runners: db.select().from(runners).orderBy(asc(runners.name)).all().map(toApi),
    }));

    authed.post("/api/runners", async (request, reply) => {
      const body = parseBody(createRunnerBody, request.body, reply);
      if (!body) return;
      const { row, token } = createRunner(db, body.name);
      return reply.code(201).send({ runner: toApi(row), token });
    });

    authed.delete<{ Params: { id: string } }>("/api/runners/:id", async (request, reply) => {
      const id = Number(request.params.id);
      const deleted = db.delete(runners).where(eq(runners.id, id)).returning().all();
      if (deleted.length === 0) return reply.code(404).send({ error: "Runner not found" });
      hub.disconnect(id);
      return reply.code(204).send();
    });

    authed.get("/api/bots", async (): Promise<{ bots: Bot[] }> => {
      const available = hub.availableAgentTypes();
      const rows = db.select().from(users).where(eq(users.kind, "bot")).orderBy(asc(users.username)).all();
      return {
        bots: rows.map((u) => ({
          id: u.id,
          username: u.username,
          kind: u.kind,
          agentType: u.agentType!,
          available: available.has(u.agentType!),
        })),
      };
    });
  });
}
