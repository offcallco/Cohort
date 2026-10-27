import { and, eq } from "drizzle-orm";
import { users, type AgentType, type Db } from "@cohort/db";

// Built-in bot users. Assigning an issue to one runs that agent on it.
export const BOTS: { username: string; agentType: AgentType }[] = [
  { username: "claude-bot", agentType: "claude-code" },
  { username: "codex-bot", agentType: "codex" },
];

export const botEmail = (username: string) => `${username}@bots.cohort.local`;

export function ensureBots(db: Db) {
  for (const bot of BOTS) {
    db.insert(users)
      .values({ username: bot.username, passwordHash: "", kind: "bot", agentType: bot.agentType })
      .onConflictDoNothing()
      .run();
  }
}

export function findBot(db: Db, id: number) {
  return db
    .select()
    .from(users)
    .where(and(eq(users.id, id), eq(users.kind, "bot")))
    .get();
}
