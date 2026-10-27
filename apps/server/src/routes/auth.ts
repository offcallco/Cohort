import type { FastifyInstance, FastifyReply } from "fastify";
import { count, eq } from "drizzle-orm";
import { users, type Db } from "@cohort/db";
import { credentials, type Status } from "@cohort/shared";
import {
  SESSION_COOKIE,
  createSession,
  deleteSession,
  hashPassword,
  verifyPassword,
} from "../auth.ts";
import { version } from "../config.ts";
import { parseBody, requireUser } from "../http.ts";

const userCount = (db: Db) => db.select({ n: count() }).from(users).get()?.n ?? 0;

function startSession(db: Db, reply: FastifyReply, userId: number) {
  const { token, expiresAt } = createSession(db, userId);
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    expires: expiresAt,
  });
}

export async function authRoutes(app: FastifyInstance, { db }: { db: Db }) {
  app.get("/api/status", async (request): Promise<Status> => ({
    setupRequired: userCount(db) === 0,
    user: request.user,
    version,
  }));

  // Creates the first (and, for now, only) account. Refused once an account exists.
  app.post("/api/setup", async (request, reply) => {
    const body = parseBody(credentials, request.body, reply);
    if (!body) return;
    if (userCount(db) > 0) return reply.code(409).send({ error: "Cohort is already set up" });
    const user = db
      .insert(users)
      .values({ username: body.username, passwordHash: await hashPassword(body.password) })
      .returning({ id: users.id, username: users.username })
      .get();
    startSession(db, reply, user.id);
    return reply.code(201).send({ user });
  });

  app.post("/api/login", async (request, reply) => {
    const body = parseBody(credentials, request.body, reply);
    if (!body) return;
    const user = db.select().from(users).where(eq(users.username, body.username)).get();
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
      return reply.code(401).send({ error: "Wrong username or password" });
    }
    startSession(db, reply, user.id);
    return { user: { id: user.id, username: user.username } };
  });

  app.post("/api/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) deleteSession(db, token);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.code(204).send();
  });

  app.get("/api/me", { preHandler: requireUser }, async (request) => ({ user: request.user }));
}
