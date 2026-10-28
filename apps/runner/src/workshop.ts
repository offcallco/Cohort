import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { JobSpec } from "@cohort/shared";
import { checkout } from "./checkout.ts";
import { git } from "./git.ts";
import type { JobContext, JobOutcome } from "./job.ts";
import { workshopPrompt } from "./prompt.ts";

const workshopDir = (dataDir: string, id: number) => join(dataDir, "workshops", `w-${id}`);

// Runs one workshop turn in a read-only checkout that's kept for the whole workshop, so the
// agent can resume its session from the same folder.
export async function runWorkshopTurn(job: JobSpec, ctx: JobContext): Promise<JobOutcome & { sessionId?: string }> {
  const { log, signal, adapter } = ctx;
  const turn = job.workshop!;
  const dir = workshopDir(ctx.dataDir, turn.id);

  try {
    if (!existsSync(dir)) {
      log(`Checking out ${job.baseBranch} for the workshop\n`);
      await checkout(job, { ...ctx, dir, startPoint: job.baseBranch });
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
      onSpawn: ctx.onSpawn,
    });
    if (result.sessionMissing && resume) {
      log("Couldn't resume the earlier session; starting a new one with the conversation so far\n");
      result = await adapter.plan({ cwd: dir, prompt: workshopPrompt(job, ctx.instructions, true), resume: null, env, signal, log });
    }
    if (signal.aborted) return { status: "canceled" };
    if (result.error) return { status: "failed", error: result.error, costUsd: result.costUsd };
    if (!result.text.trim()) return { status: "failed", error: "The agent didn't reply" };
    return { status: "succeeded", summary: result.text, sessionId: result.sessionId ?? undefined, costUsd: result.costUsd };
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
