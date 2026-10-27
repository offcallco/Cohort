import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";

// Validates `body` against `schema`, replying 400 with the first issue on failure.
export function parseBody<T extends z.ZodType>(
  schema: T,
  body: unknown,
  reply: FastifyReply,
): z.infer<T> | undefined {
  const result = schema.safeParse(body ?? {});
  if (result.success) return result.data;
  reply.code(400).send({ error: result.error.issues[0]?.message ?? "Invalid request" });
  return undefined;
}

export async function requireUser(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user) await reply.code(401).send({ error: "Sign in required" });
}
