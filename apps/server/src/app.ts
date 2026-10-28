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
import websocket from "@fastify/websocket";
import { ensureBots } from "./bots.ts";
import { JobLogs } from "./jobs/logs.ts";
import { Jobs } from "./jobs/service.ts";
import { RunnerHub, type HubOptions } from "./runners/hub.ts";
import { runnerRoutes } from "./routes/runners.ts";
import { jobRoutes } from "./routes/jobs.ts";
import { mergeRequestRoutes } from "./routes/mrs.ts";
import { workshopRoutes } from "./routes/workshops.ts";
import { Workshops } from "./workshops/service.ts";
import { Pipelines } from "./pipelines/service.ts";
import { pipelineRoutes } from "./routes/pipelines.ts";
import { missionRoutes } from "./routes/mission.ts";
import { MissionService } from "./mission.ts";
import { StoryService } from "./issues/story.ts";
import { reposListRoutes } from "./routes/reposList.ts";
import { join } from "node:path";

declare module "fastify" {
  interface FastifyRequest {
    user: User | null;
  }
  interface FastifyInstance {
    hub: RunnerHub;
    jobs: Jobs;
    pipelines: Pipelines;
  }
}

export interface AppOptions {
  db: Db;
  // Folder holding the bare repos.
  reposRoot: string;
  // Folder for job logs.
  logsDir: string;
  hub?: HubOptions;
  // Built web app to serve at "/". Omitted in dev, where Vite serves the UI.
  webDist?: string;
  allowedHosts?: string[];
  logger?: boolean;
}

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

export async function buildApp({ db, reposRoot, logsDir, hub: hubOptions, webDist, allowedHosts = [], logger = false }: AppOptions) {
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
  await app.register(websocket);

  ensureBots(db);
  const jobs = new Jobs(db, reposRoot, new JobLogs(logsDir));
  const pipelines = new Pipelines(db, reposRoot, new JobLogs(join(logsDir, "ci")));
  jobs.pipelines = pipelines;
  const hub = new RunnerHub(db, jobs, pipelines, hubOptions);
  const workshops = new Workshops(db, reposRoot, jobs);
  workshops.broadcaster = hub;
  hub.start();
  app.addHook("onClose", async () => hub.stop());
  app.decorate("hub", hub);
  app.decorate("jobs", jobs);
  app.decorate("pipelines", pipelines);

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
  await app.register(reposListRoutes, { db, reposRoot });
  await app.register(issueRoutes, { db, jobs, story: new StoryService(db, reposRoot, jobs, pipelines) });
  await app.register(runnerRoutes, { db, hub });
  const mission = new MissionService(db, reposRoot, jobs);
  await app.register(jobRoutes, { db, jobs, mission });
  await app.register(mergeRequestRoutes, { db, reposRoot, jobs, pipelines });
  await app.register(pipelineRoutes, { db, pipelines });
  await app.register(missionRoutes, { mission });
  await app.register(workshopRoutes, { db, workshops });
  await app.register(gitHttpRoutes, { db, reposRoot, pipelines });

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
