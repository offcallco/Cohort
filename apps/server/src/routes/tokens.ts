import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { accessTokens, type Db } from "@cohort/db";
import { createTokenBody, type AccessToken, type CreatedAccessToken } from "@cohort/shared";
import { createAccessToken } from "../auth.ts";
import { parseBody, requireUser } from "../http.ts";

const toApi = (row: typeof accessTokens.$inferSelect): AccessToken => ({
  id: row.id,
  name: row.name,
  prefix: row.prefix,
  createdAt: row.createdAt.toISOString(),
  lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
});

export async function tokenRoutes(app: FastifyInstance, { db }: { db: Db }) {
  app.addHook("preHandler", requireUser);

  app.get("/api/tokens", async (request): Promise<{ tokens: AccessToken[] }> => {
    const rows = db
      .select()
      .from(accessTokens)
      .where(eq(accessTokens.userId, request.user!.id))
      .orderBy(desc(accessTokens.createdAt))
      .all();
    return { tokens: rows.map(toApi) };
  });

  app.post("/api/tokens", async (request, reply) => {
    const body = parseBody(createTokenBody, request.body, reply);
    if (!body) return;
    const { row, token } = createAccessToken(db, request.user!.id, body.name);
    const created: CreatedAccessToken = { ...toApi(row), token };
    return reply.code(201).send({ token: created });
  });

  app.delete<{ Params: { id: string } }>("/api/tokens/:id", async (request, reply) => {
    const deleted = db
      .delete(accessTokens)
      .where(
        and(
          eq(accessTokens.id, Number(request.params.id)),
          eq(accessTokens.userId, request.user!.id),
        ),
      )
      .returning({ id: accessTokens.id })
      .all();
    if (deleted.length === 0) return reply.code(404).send({ error: "Token not found" });
    return reply.code(204).send();
  });
}
