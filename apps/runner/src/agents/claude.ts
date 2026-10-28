import type { AgentConfig } from "../config.ts";
import { commandWorks, runProcess } from "../process.ts";
import type { AgentAdapter, PlanOptions, PlanResult, RunOptions, RunResult } from "./types.ts";

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  is_error?: boolean;
  content?: unknown;
}

interface StreamEvent {
  type: string;
  subtype?: string;
  model?: string;
  session_id?: string;
  message?: { content?: ContentBlock[] };
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
}

// One-line description of a tool call, e.g. "Edit src/app.ts".
function describeTool(block: ContentBlock) {
  const input = block.input ?? {};
  const detail = input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.url ?? input.description;
  return `→ ${block.name}${typeof detail === "string" ? ` ${detail.split("\n")[0]!.slice(0, 160)}` : ""}`;
}

interface Session {
  result: StreamEvent | null;
  sessionId: string | null;
  code: number | null;
  stderr: string;
  sessionMissing: boolean;
}

// Claude Code in headless mode (`claude -p`), reading its stream-json events.
export class ClaudeCodeAgent implements AgentAdapter {
  readonly type = "claude-code" as const;
  readonly resumable = true;
  readonly name: string;
  private readonly command: string;

  constructor(private readonly config: AgentConfig) {
    this.name = config.name;
    this.command = config.command ?? "claude";
  }

  available() {
    return commandWorks(this.command, ["--version"]);
  }

  private async session(
    { cwd, prompt, env, signal, log }: RunOptions,
    permissionMode: string,
    resume: string | null,
  ): Promise<Session> {
    const args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      permissionMode,
      ...(resume ? ["--resume", resume] : []),
      ...(this.config.model ? ["--model", this.config.model] : []),
      ...this.config.args,
    ];
    let result: StreamEvent | null = null;
    let sessionId: string | null = null;
    let sessionMissing = false;

    const { code, stderr } = await runProcess(this.command, args, {
      cwd,
      env,
      signal,
      onStdoutLine: (line) => {
        if (!line.trim()) return;
        let event: StreamEvent;
        try {
          event = JSON.parse(line) as StreamEvent;
        } catch {
          if (/No conversation found/i.test(line)) sessionMissing = true;
          log(`${line}\n`);
          return;
        }
        if (event.session_id) sessionId = event.session_id;
        if (event.type === "system" && event.subtype === "init") {
          log(`Claude Code ${resume ? "resumed" : "started"}${event.model ? ` (${event.model})` : ""}\n`);
        } else if (event.type === "assistant") {
          for (const block of event.message?.content ?? []) {
            if (block.type === "text" && block.text?.trim()) log(`${block.text.trim()}\n`);
            else if (block.type === "tool_use") log(`${describeTool(block)}\n`);
          }
        } else if (event.type === "user") {
          for (const block of event.message?.content ?? []) {
            if (block.type === "tool_result" && block.is_error) {
              const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
              log(`  ✗ ${text.split("\n")[0]!.slice(0, 200)}\n`);
            }
          }
        } else if (event.type === "result") {
          result = event;
          if (typeof event.total_cost_usd === "number") log(`Cost: $${event.total_cost_usd.toFixed(4)}\n`);
        }
      },
      onStderr: (text) => {
        if (/No conversation found/i.test(text)) sessionMissing = true;
        log(text);
      },
    });
    return { result, sessionId, code, stderr, sessionMissing };
  }

  private failure(s: Session): string | undefined {
    const final = s.result;
    if (!final) return `claude exited with code ${s.code}${s.stderr ? `: ${s.stderr.trim().slice(-500)}` : ""}`;
    if (final.is_error || final.subtype !== "success") return final.result || `Claude Code stopped: ${final.subtype}`;
    return undefined;
  }

  async implement(options: RunOptions): Promise<RunResult> {
    const s = await this.session(options, this.config.permission_mode, null);
    if (options.signal.aborted) return { summary: "", error: "Canceled" };
    return { summary: s.result?.result ?? "", error: this.failure(s) };
  }

  async plan(options: PlanOptions): Promise<PlanResult> {
    // "plan" mode: Claude can read files and search, but not edit or run commands.
    const s = await this.session(options, "plan", options.resume);
    if (options.signal.aborted) return { text: "", sessionId: s.sessionId, error: "Canceled" };
    const error = this.failure(s);
    return {
      text: s.result?.result ?? "",
      sessionId: s.sessionId,
      error,
      sessionMissing: error !== undefined && s.sessionMissing,
    };
  }
}
