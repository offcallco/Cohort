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

export interface AgentAdapter {
  readonly name: string;
  readonly type: AgentType;
  // Whether the agent's CLI is installed and runnable.
  available(): Promise<boolean>;
  implement(options: RunOptions): Promise<RunResult>;
}
