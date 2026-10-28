import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig } from "../config.ts";
import { commandWorks, runProcess } from "../process.ts";
import type { AgentAdapter, PlanOptions, PlanResult, RunOptions, RunResult } from "./types.ts";

interface CodexEvent {
  type?: string;
  item?: { type?: string; text?: string; command?: string; changes?: { path?: string; kind?: string }[] };
  // Older event shape: { msg: { type, ... } }
  msg?: { type?: string; message?: string; command?: string[] | string };
  message?: string;
  error?: { message?: string };
}

// OpenAI Codex CLI in non-interactive mode (`codex exec --json`).
export class CodexAgent implements AgentAdapter {
  readonly type = "codex" as const;
  // Each plan turn starts fresh with the full transcript.
  readonly resumable = false;
  readonly name: string;
  private readonly command: string;

  constructor(private readonly config: AgentConfig) {
    this.name = config.name;
    this.command = config.command ?? "codex";
  }

  available() {
    return commandWorks(this.command, ["--version"]);
  }

  implement(options: RunOptions): Promise<RunResult> {
    return this.exec(options, ["--full-auto"]);
  }

  async plan(options: PlanOptions): Promise<PlanResult> {
    // Read-only sandbox: Codex can read files and run read-only commands, but not write.
    const { summary, error } = await this.exec(options, ["--sandbox", "read-only"]);
    return { text: summary, sessionId: null, error };
  }

  private async exec({ cwd, prompt, env, signal, log, onSpawn }: RunOptions, mode: string[]): Promise<RunResult> {
    const tmp = mkdtempSync(join(tmpdir(), "cohort-codex-"));
    const lastMessage = join(tmp, "last-message.txt");
    const args = [
      "exec",
      "--json",
      ...mode,
      "--skip-git-repo-check",
      "--cd",
      cwd,
      "--output-last-message",
      lastMessage,
      ...(this.config.model ? ["--model", this.config.model] : []),
      ...this.config.args,
      prompt,
    ];
    let failure: string | undefined;

    try {
      const { code, stderr } = await runProcess(this.command, args, {
        cwd,
        env,
        signal,
        onSpawn,
        onStdoutLine: (line) => {
          if (!line.trim()) return;
          let event: CodexEvent;
          try {
            event = JSON.parse(line) as CodexEvent;
          } catch {
            log(`${line}\n`);
            return;
          }
          const item = event.item;
          if (event.type === "item.completed" && item) {
            if (item.type === "agent_message" && item.text) log(`${item.text.trim()}\n`);
            else if (item.type === "command_execution" && item.command) log(`$ ${item.command}\n`);
            else if (item.type === "file_change" && item.changes) {
              for (const c of item.changes) log(`→ ${c.kind ?? "edit"} ${c.path ?? ""}\n`);
            }
          } else if (event.type === "error" || event.type === "turn.failed") {
            failure = event.message ?? event.error?.message ?? "Codex reported an error";
            log(`✗ ${failure}\n`);
          } else if (event.msg?.type === "agent_message" && event.msg.message) {
            log(`${event.msg.message.trim()}\n`);
          } else if (event.msg?.type === "exec_command_begin" && event.msg.command) {
            const cmd = Array.isArray(event.msg.command) ? event.msg.command.join(" ") : event.msg.command;
            log(`$ ${cmd}\n`);
          }
        },
        onStderr: (text) => log(text),
      });

      if (signal.aborted) return { summary: "", error: "Canceled" };
      let summary = "";
      try {
        summary = readFileSync(lastMessage, "utf8").trim();
      } catch {
        // Codex didn't write a final message.
      }
      if (code !== 0) {
        return { summary, error: failure ?? `codex exited with code ${code}${stderr ? `: ${stderr.trim().slice(-500)}` : ""}` };
      }
      return failure ? { summary, error: failure } : { summary };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}
