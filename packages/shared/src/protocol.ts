import { z } from "zod";

// Messages exchanged over the runner WebSocket (/api/runners/connect).

export const AGENT_TYPES = ["claude-code", "codex", "command"] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

export interface WorkshopTurn {
  id: number;
  title: string;
  // "finalize" asks the agent for the final plan and a list of issues.
  mode: "turn" | "finalize";
  // Session to resume on this runner, if it has one.
  sessionId: string | null;
  // Every message so far, oldest first, for agents starting a fresh session.
  transcript: { role: "user" | "agent" | "system"; body: string }[];
  // The user's newest message (the idea itself on the first turn).
  message: string;
  plan: string;
}

export type JobKind = "implement" | "workshop" | "split" | "resolve";

export interface JobSpec {
  id: number;
  kind: JobKind;
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
  workshop?: WorkshopTurn;
  // Resolve jobs: merge `source` into `target` (the job's branch) and fix the conflicts.
  resolve?: { source: string; target: string };
  // Split jobs on sub-issues never split again.
  noSplit?: boolean;
}

// A CI job from .cohort-ci.yml, run with a shell on the runner.
export interface CiJobSpec {
  id: number;
  pipelineId: number;
  project: string;
  clonePath: string;
  // Read-only git credential for this job.
  token: string;
  ref: string;
  sha: string;
  name: string;
  stage: string;
  script: string[];
  variables: Record<string, string>;
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
    // Whether this runner takes CI jobs, and the ones it's still running.
    ci: z.boolean().default(false),
    runningCi: z.array(z.number().int()).default([]),
  }),
  // `ci: true` marks messages about CI jobs, whose ids are separate from agent jobs'.
  z.object({ type: z.literal("started"), jobId: z.number().int(), ci: z.boolean().optional() }),
  z.object({ type: z.literal("log"), jobId: z.number().int(), text: z.string(), ci: z.boolean().optional() }),
  z.object({
    type: z.literal("finished"),
    jobId: z.number().int(),
    ci: z.boolean().optional(),
    status: z.enum(["succeeded", "failed", "canceled"]),
    summary: z.string().optional(),
    error: z.string().optional(),
    commitSha: z.string().optional(),
    // Workshop turns: the agent session, so the next turn can resume it.
    sessionId: z.string().optional(),
    // Split jobs: the runner's max_subtasks, above which a split needs approval.
    maxSubtasks: z.number().int().optional(),
    // What the agent reported the run cost, if it reports one.
    costUsd: z.number().nonnegative().optional(),
  }),
  // The runner couldn't take an assigned job (no capacity, unknown agent); requeue it.
  z.object({ type: z.literal("rejected"), jobId: z.number().int(), reason: z.string(), ci: z.boolean().optional() }),
]);
export type RunnerMessage = z.infer<typeof runnerMessage>;

export type ServerMessage =
  | { type: "welcome"; runnerId: number; name: string }
  | { type: "assign"; job: JobSpec }
  | { type: "cancel"; jobId: number }
  | { type: "assign_ci"; job: CiJobSpec }
  | { type: "cancel_ci"; jobId: number }
  // The workshop is over; its checkout can be removed.
  | { type: "workshop_closed"; workshopId: number };
