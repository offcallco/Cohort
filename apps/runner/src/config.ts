import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";
import { AGENT_TYPES } from "@cohort/shared";

const agentConfig = z.object({
  name: z.string().min(1),
  type: z.enum(AGENT_TYPES),
  // Max jobs at once for this agent.
  limit: z.number().int().positive().default(1),
  // Executable to run; defaults to "claude" / "codex". For type "command", a shell command.
  command: z.string().optional(),
  // Extra command-line arguments.
  args: z.array(z.string()).default([]),
  model: z.string().optional(),
  // Claude Code only. "acceptEdits" lets it edit files but not run arbitrary commands.
  permission_mode: z.string().default("acceptEdits"),
});
export type AgentConfig = z.infer<typeof agentConfig>;

const runnerConfig = z.object({
  // Cohort server, e.g. "http://127.0.0.1:7700".
  url: z.string().url(),
  token: z.string().min(1),
  // Max jobs at once on this runner, all agents combined.
  concurrent: z.number().int().positive().default(2),
  // Where repo caches and worktrees go; defaults to the config file's folder.
  data_dir: z.string().optional(),
  agents: z.array(agentConfig).default([]),
  context: z.object({ instructions: z.string().default("") }).default({ instructions: "" }),
  split: z
    .object({
      // Agents aim for at most this many sub-issues.
      max_subtasks: z.number().int().positive().default(4),
      // When true, a split into more than max_subtasks waits for a person's approval.
      require_approval: z.boolean().default(false),
      // 0 turns splitting off; 1 lets issues split once (sub-issues never split again).
      max_depth: z.number().int().min(0).max(1).default(1),
    })
    .default({ max_subtasks: 4, require_approval: false, max_depth: 1 }),
  ci: z
    .object({
      // Run CI jobs from .cohort-ci.yml. They run shell commands from the repo on this machine.
      enabled: z.boolean().default(true),
      // A CI job running longer than this is stopped and fails.
      timeout_minutes: z.number().positive().default(60),
    })
    .default({ enabled: true, timeout_minutes: 60 }),
});

export type RunnerConfig = z.infer<typeof runnerConfig> & { dataDir: string };

export function loadConfig(file: string): RunnerConfig {
  const raw = parse(readFileSync(file, "utf8"));
  const result = runnerConfig.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    throw new Error(`Invalid ${file}: ${issue.path.join(".") || "config"}: ${issue.message}`);
  }
  const config = result.data;
  const names = new Set<string>();
  for (const agent of config.agents) {
    if (names.has(agent.name)) throw new Error(`Invalid ${file}: duplicate agent name "${agent.name}"`);
    names.add(agent.name);
  }
  return { ...config, url: config.url.replace(/\/+$/, ""), dataDir: resolve(dirname(file), config.data_dir ?? ".") };
}
