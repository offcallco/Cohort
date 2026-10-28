import type { FastifyInstance } from "fastify";
import { requireUser } from "../http.ts";
import type { MissionService } from "../mission.ts";

export async function missionRoutes(app: FastifyInstance, { mission }: { mission: MissionService }) {
  app.addHook("preHandler", requireUser);

  // Home screen: what needs you, what's running, what just finished.
  app.get("/api/mission", async () => mission.summary());

  // The inbox: everything waiting on a person.
  app.get("/api/reviews", async () => ({ items: await mission.needsYou() }));
}
