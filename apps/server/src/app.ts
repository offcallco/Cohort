import Fastify from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import type { Db } from "@cohort/db";
import type { User } from "@cohort/shared";
import { SESSION_COOKIE, userForAccessToken, userForSession } from "./auth.ts";
import { authRoutes } from "./routes/auth.ts";
import { tokenRoutes } from "./routes/tokens.ts";
import { workspaceRoutes } from "./routes/workspaces.ts";
import { repoRoutes } from "./routes/repos.ts";
import { issueRoutes } from "./routes/issues.ts";
import { gitHttpRoutes } from "./git/http.ts";

declare module "fastify" {
  interface FastifyRequest {
    user: User | null;
  }
}

export interface AppOptions {
  db: Db;
  // Folder holding the bare repos.
  reposRoot: string;
  // Built web app to serve at "/". Omitted in dev, where Vite serves the UI.
  webDist?: string;
  allowedHosts?: string[];
  logger?: boolean;
}

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

export async function buildApp({ db, reposRoot, webDist, allowedHosts = [], logger = false }: AppOptions) {
  const app = Fastify({ logger });
  const hosts = new Set([...LOCAL_HOSTS, ...allowedHosts]);

  // Reject requests addressed to unknown hostnames. Stops other websites from reaching
  // this local server through DNS rebinding.
  app.addHook("onRequest", async (request, reply) => {
    if (!hosts.has(request.hostname)) {
      return reply.code(403).send({ error: `Host "${request.hostname}" is not allowed` });
    }
  });

  await app.register(cookie);

  app.decorateRequest("user", null);
  app.addHook("onRequest", async (request) => {
    const bearer = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (bearer) {
      request.user = userForAccessToken(db, bearer);
      return;
    }
    const session = request.cookies[SESSION_COOKIE];
    if (session) request.user = userForSession(db, session);
  });

  await app.register(authRoutes, { db });
  await app.register(tokenRoutes, { db });
  await app.register(workspaceRoutes, { db, reposRoot });
  await app.register(repoRoutes, { db, reposRoot });
  await app.register(issueRoutes, { db });
  await app.register(gitHttpRoutes, { db, reposRoot });

  const serveWeb = webDist !== undefined && existsSync(webDist);
  if (serveWeb) await app.register(fastifyStatic, { root: webDist, wildcard: false });

  app.setNotFoundHandler((request, reply) => {
    // Client-side routes: any non-API GET gets the single-page app.
    if (serveWeb && request.method === "GET" && !request.url.startsWith("/api/")) {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "Not found" });
  });

  return app;
}
