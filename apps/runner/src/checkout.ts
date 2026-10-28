import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { JobSpec } from "@cohort/shared";
import { git, type KeyedLock } from "./git.ts";

export const cachePath = (dataDir: string, project: string) => join(dataDir, "cache", `${project}.git`);

// Job token only: no credential helpers, so nothing stored on this machine is used.
export const authArgs = (job: JobSpec) => ["-c", "credential.helper=", "-c", `http.extraHeader=Authorization: Bearer ${job.token}`];

// Fetches the project into the runner's cache (a bare repo shared by all jobs for that
// project) and adds a worktree at `dir`. With `branch`, the worktree is on a local branch
// created at `startPoint`; otherwise it's detached.
export async function checkout(
  job: JobSpec,
  options: { serverUrl: string; dataDir: string; locks: KeyedLock; dir: string; startPoint: string; branch?: string; commit?: boolean },
) {
  const cache = cachePath(options.dataDir, job.project);
  const url = `${options.serverUrl}${job.clonePath}`;
  await options.locks.run(cache, async () => {
    if (!existsSync(cache)) {
      mkdirSync(cache, { recursive: true });
      await git(["init", "--bare", "--quiet", cache]);
    }
    await git(["--git-dir", cache, ...authArgs(job), "fetch", "--prune", "--quiet", url, "+refs/heads/*:refs/remotes/origin/*"], {
      secrets: [job.token],
    });
    rmSync(options.dir, { recursive: true, force: true });
    await git(["--git-dir", cache, "worktree", "prune"]);
    const target = options.branch ? ["-B", options.branch] : ["--detach"];
    // `commit`: startPoint is a commit sha rather than a branch name.
    const start = options.commit ? options.startPoint : `refs/remotes/origin/${options.startPoint}`;
    await git(["--git-dir", cache, "worktree", "add", "--quiet", "--force", ...target, options.dir, start]);
  });
}

export async function removeCheckout(options: { dataDir: string; locks: KeyedLock; project: string; dir: string; branch?: string }) {
  const cache = cachePath(options.dataDir, options.project);
  await options.locks
    .run(cache, async () => {
      if (!existsSync(cache)) return;
      await git(["--git-dir", cache, "worktree", "remove", "--force", options.dir]).catch(() => undefined);
      if (options.branch) await git(["--git-dir", cache, "branch", "-D", options.branch]).catch(() => undefined);
    })
    .catch(() => undefined);
  rmSync(options.dir, { recursive: true, force: true });
}
