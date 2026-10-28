import { execFile } from "node:child_process";

export class GitCommandError extends Error {}

// Runs git, keeping secrets out of error messages.
export function git(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; secrets?: string[] } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: options.cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.env },
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        let message = stderr.trim() || error.message;
        for (const secret of options.secrets ?? []) message = message.split(secret).join("***");
        const shown = args.filter((a) => !(options.secrets ?? []).some((s) => a.includes(s)));
        reject(new GitCommandError(`git ${shown.slice(0, 3).join(" ")} failed: ${message}`));
      },
    );
  });
}

// Serializes work per key (e.g. per repo cache), so concurrent jobs don't fight over git locks.
export class KeyedLock {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.tails.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }
}
