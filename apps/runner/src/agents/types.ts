import type { AgentType } from "@cohort/shared";

export interface RunOptions {
  // Worktree the agent works in.
  cwd: string;
  prompt: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  log: (text: string) => void;
}

export interface RunResult {
  // The agent's final message, used for the MR description and issue comment.
  summary: string;
  error?: string;
}

export interface PlanOptions extends RunOptions {
  // Session to continue; only used by adapters that can resume.
  resume: string | null;
}

export interface PlanResult {
  text: string;
  sessionId: string | null;
  error?: string;
  // The session to resume wasn't found; start a fresh one with the full transcript.
  sessionMissing?: boolean;
}

export interface AgentAdapter {
  readonly name: string;
  readonly type: AgentType;
  // Whether plan() can continue an earlier session instead of rereading the transcript.
  readonly resumable: boolean;
  // Whether the agent's CLI is installed and runnable.
  available(): Promise<boolean>;
  implement(options: RunOptions): Promise<RunResult>;
  // Read-only turn: the agent may read the code but not change anything.
  plan(options: PlanOptions): Promise<PlanResult>;
}
