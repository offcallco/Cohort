import { spawn } from "node:child_process";

export interface ProcessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal: AbortSignal;
  onStdoutLine?: (line: string) => void;
  onStderr?: (text: string) => void;
}

// Runs a command in its own process group so cancelling also stops anything it started.
// Resolves with the exit code (null if it was killed) and the last part of stderr.
export function runProcess(command: string, args: string[], options: ProcessOptions) {
  return new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    if (options.signal.aborted) return resolve({ code: null, stderr: "" });
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stderr = "";
    let partial = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const lines = (partial + chunk).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) options.onStdoutLine?.(line);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
      options.onStderr?.(chunk);
    });

    const kill = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        // Already gone.
      }
    };
    let forceTimer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      kill("SIGTERM");
      forceTimer = setTimeout(() => kill("SIGKILL"), 5000);
    };
    options.signal.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      options.signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      options.signal.removeEventListener("abort", onAbort);
      clearTimeout(forceTimer);
      if (partial) options.onStdoutLine?.(partial);
      resolve({ code: options.signal.aborted ? null : code, stderr });
    });
  });
}

export async function commandWorks(command: string, args: string[]) {
  try {
    const { code } = await runProcess(command, args, { cwd: process.cwd(), signal: new AbortController().signal });
    return code === 0;
  } catch {
    return false;
  }
}
