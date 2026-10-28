import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { JobSpec } from "@cohort/shared";
import { git } from "./git.ts";
import type { JobContext, JobOutcome } from "./job.ts";
import { workshopPrompt } from "./prompt.ts";

const workshopDir = (dataDir: string, id: number) => join(dataDir, "workshops", `w-${id}`);
const cacheDir = (dataDir: string, project: string) => join(dataDir, "cache", `${project}.git`);

// Runs one workshop turn in a read-only checkout that's kept for the whole workshop, so the
// agent can resume its session from the same folder.
export async function runWorkshopTurn(job: JobSpec, ctx: JobContext): Promise<JobOutcome & { sessionId?: string }> {
  const { log, signal, adapter } = ctx;
  const turn = job.workshop!;
  const dir = workshopDir(ctx.dataDir, turn.id);
  const cache = cacheDir(ctx.dataDir, job.project);
  const url = `${ctx.serverUrl}${job.clonePath}`;
  const auth = ["-c", "credential.helper=", "-c", `http.extraHeader=Authorization: Bearer ${job.token}`];

  try {
    if (!existsSync(dir)) {
      log(`Checking out ${job.baseBranch} for the workshop\n`);
      await ctx.locks.run(cache, async () => {
        if (!existsSync(cache)) {
          mkdirSync(cache, { recursive: true });
          await git(["init", "--bare", "--quiet", cache]);
        }
        await git(["--git-dir", cache, ...auth, "fetch", "--prune", "--quiet", url, "+refs/heads/*:refs/remotes/origin/*"], {
          secrets: [job.token],
        });
        await git(["--git-dir", cache, "worktree", "prune"]);
        await git(["--git-dir", cache, "worktree", "add", "--quiet", "--detach", "--force", dir, `refs/remotes/origin/${job.baseBranch}`]);
      });
    }
    if (signal.aborted) return { status: "canceled" };

    const env = { ...process.env };
    const resume = adapter.resumable ? turn.sessionId : null;
    let result = await adapter.plan({
      cwd: dir,
      prompt: workshopPrompt(job, ctx.instructions, resume === null),
      resume,
      env,
      signal,
      log,
    });
    if (result.sessionMissing && resume) {
      log("Couldn't resume the earlier session; starting a new one with the conversation so far\n");
      result = await adapter.plan({ cwd: dir, prompt: workshopPrompt(job, ctx.instructions, true), resume: null, env, signal, log });
    }
    if (signal.aborted) return { status: "canceled" };
    if (result.error) return { status: "failed", error: result.error };
    if (!result.text.trim()) return { status: "failed", error: "The agent didn't reply" };
    return { status: "succeeded", summary: result.text, sessionId: result.sessionId ?? undefined };
  } catch (error) {
    if (signal.aborted) return { status: "canceled" };
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

// Removes a finished workshop's checkout.
export async function removeWorkshop(dataDir: string, workshopId: number, locks: JobContext["locks"]) {
  const dir = workshopDir(dataDir, workshopId);
  if (!existsSync(dir)) return;
  const gitFile = join(dir, ".git");
  // The checkout's .git file points at the cache it belongs to.
  let cache: string | null = null;
  try {
    const { readFileSync } = await import("node:fs");
    const pointer = readFileSync(gitFile, "utf8").match(/^gitdir: (.*)\/worktrees\/[^/]+\s*$/m);
    cache = pointer?.[1] ?? null;
  } catch {
    // Not a worktree; just delete it.
  }
  if (cache) {
    await locks.run(cache, () => git(["--git-dir", cache!, "worktree", "remove", "--force", dir]).catch(() => ""));
  }
  rmSync(dir, { recursive: true, force: true });
}
