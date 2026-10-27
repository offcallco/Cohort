import type { AgentConfig } from "../config.ts";
import { ClaudeCodeAgent } from "./claude.ts";
import { CodexAgent } from "./codex.ts";
import { CommandAgent } from "./command.ts";
import type { AgentAdapter } from "./types.ts";

export type { AgentAdapter } from "./types.ts";

export function createAdapter(config: AgentConfig): AgentAdapter {
  switch (config.type) {
    case "claude-code":
      return new ClaudeCodeAgent(config);
    case "codex":
      return new CodexAgent(config);
    case "command":
      return new CommandAgent(config);
  }
}
