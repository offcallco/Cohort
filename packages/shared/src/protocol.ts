import { z } from "zod";

// Messages exchanged over the runner WebSocket (/api/runners/connect).

export const AGENT_TYPES = ["claude-code", "codex", "command"] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

export interface JobSpec {
  id: number;
  kind: "implement";
  agent: AgentType;
  // "<workspace>/<project>"
  project: string;
  // Path on the server, e.g. "/acme/api.git". The runner prefixes its server URL.
  clonePath: string;
  // Git credential for this job only; sent as a Bearer token.
  token: string;
  branch: string;
  baseBranch: string;
  // True on retries: the branch already exists and work continues on top of it.
  branchExists: boolean;
  issue: { number: number; title: string; body: string; labels: string[] } | null;
  // Project runner context from the UI.
  context: string;
  // Identity for commits the runner makes.
  bot: { name: string; email: string };
}

const agentInfo = z.object({
  name: z.string(),
  type: z.enum(AGENT_TYPES),
  limit: z.number().int().positive(),
});
export type AgentInfo = z.infer<typeof agentInfo>;

export const runnerMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    version: z.string(),
    concurrent: z.number().int().positive(),
    agents: z.array(agentInfo),
    // Jobs the runner is still working on after a reconnect.
    running: z.array(z.number().int()).default([]),
  }),
  z.object({ type: z.literal("started"), jobId: z.number().int() }),
  z.object({ type: z.literal("log"), jobId: z.number().int(), text: z.string() }),
  z.object({
    type: z.literal("finished"),
    jobId: z.number().int(),
    status: z.enum(["succeeded", "failed", "canceled"]),
    summary: z.string().optional(),
    error: z.string().optional(),
    commitSha: z.string().optional(),
  }),
  // The runner couldn't take an assigned job (no capacity, unknown agent); requeue it.
  z.object({ type: z.literal("rejected"), jobId: z.number().int(), reason: z.string() }),
]);
export type RunnerMessage = z.infer<typeof runnerMessage>;

export type ServerMessage =
  | { type: "welcome"; runnerId: number; name: string }
  | { type: "assign"; job: JobSpec }
  | { type: "cancel"; jobId: number };
