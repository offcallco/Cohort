import type { AgentConfig } from "../config.ts";
import { runProcess } from "../process.ts";
import type { AgentAdapter, RunOptions, RunResult } from "./types.ts";

// Runs any shell command as the "agent". The prompt is in $COHORT_PROMPT. The last line of
// output becomes the summary. Handy for scripted agents and for tests.
export class CommandAgent implements AgentAdapter {
  readonly type = "command" as const;
  readonly name: string;

  constructor(private readonly config: AgentConfig) {
    if (!config.command) throw new Error(`Agent "${config.name}" needs a command`);
    this.name = config.name;
  }

  async available() {
    return true;
  }

  async implement({ cwd, prompt, env, signal, log }: RunOptions): Promise<RunResult> {
    let last = "";
    const { code, stderr } = await runProcess("/bin/sh", ["-c", this.config.command!, ...this.config.args], {
      cwd,
      env: { ...env, COHORT_PROMPT: prompt },
      signal,
      onStdoutLine: (line) => {
        log(`${line}\n`);
        if (line.trim()) last = line.trim();
      },
      onStderr: (text) => log(text),
    });
    if (signal.aborted) return { summary: "", error: "Canceled" };
    if (code !== 0) return { summary: last, error: `Command exited with code ${code}${stderr ? `: ${stderr.trim().slice(-300)}` : ""}` };
    return { summary: last };
  }
}
