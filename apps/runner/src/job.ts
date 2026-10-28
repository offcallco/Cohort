import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JobSpec } from "@cohort/shared";
import type { AgentAdapter } from "./agents/index.ts";
import { authArgs, checkout, removeCheckout } from "./checkout.ts";
import type { RunnerConfig } from "./config.ts";
import { git, GitCommandError, KeyedLock } from "./git.ts";
import { implementPrompt, planPrompt, resolvePrompt } from "./prompt.ts";

export interface JobContext {
  serverUrl: string;
  dataDir: string;
  instructions: string;
  split: RunnerConfig["split"];
  adapter: AgentAdapter;
  signal: AbortSignal;
  log: (text: string) => void;
  locks: KeyedLock;
  // Agent processes register here so the run can be paused.
  onSpawn?: (pid: number) => void;
}

export interface JobOutcome {
  status: "succeeded" | "failed" | "canceled";
  summary?: string;
  error?: string;
  commitSha?: string;
  maxSubtasks?: number;
  costUsd?: number;
}

const identityEnv = (job: JobSpec) => ({
  GIT_AUTHOR_NAME: job.bot.name,
  GIT_AUTHOR_EMAIL: job.bot.email,
  GIT_COMMITTER_NAME: job.bot.name,
  GIT_COMMITTER_EMAIL: job.bot.email,
});

// Runs `work` in a fresh worktree for the job and always cleans it up afterwards.
async function inWorktree<T>(
  job: JobSpec,
  ctx: JobContext,
  startPoint: string,
  withBranch: boolean,
  work: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = join(ctx.dataDir, "worktrees", `job-${job.id}`);
  const branch = withBranch ? `cohort-job-${job.id}` : undefined;
  try {
    ctx.log(`Fetching ${job.project}\n`);
    await checkout(job, { ...ctx, dir, startPoint, branch });
    return await work(dir);
  } finally {
    await removeCheckout({ dataDir: ctx.dataDir, locks: ctx.locks, project: job.project, dir, branch });
  }
}

const failure = (ctx: JobContext, error: unknown): JobOutcome =>
  ctx.signal.aborted ? { status: "canceled" } : { status: "failed", error: error instanceof Error ? error.message : String(error) };

// Implement: check out the branch, run the agent, commit what's left, push the branch.
export async function runImplementJob(job: JobSpec, ctx: JobContext): Promise<JobOutcome> {
  const { log, signal } = ctx;
  const url = `${ctx.serverUrl}${job.clonePath}`;
  const startRef = job.branchExists ? job.branch : job.baseBranch;
  try {
    return await inWorktree(job, ctx, startRef, true, async (dir) => {
      log(`Checked out ${job.branchExists ? job.branch : `${job.baseBranch} as ${job.branch}`}\n\n`);
      if (signal.aborted) return { status: "canceled" };

      const result = await ctx.adapter.implement({
        cwd: dir,
        prompt: implementPrompt(job, ctx.instructions),
        // The agent's own commits use the bot identity too.
        env: { ...process.env, ...identityEnv(job) },
        signal,
        log,
        onSpawn: ctx.onSpawn,
      });
      if (signal.aborted) return { status: "canceled" };
      if (result.error) return { status: "failed", error: result.error, summary: result.summary, costUsd: result.costUsd };

      if ((await git(["status", "--porcelain"], { cwd: dir })).trim()) {
        const title = job.issue ? `${job.issue.title} (#${job.issue.number})` : `Changes from job ${job.id}`;
        await git(["add", "--all"], { cwd: dir });
        await git(["commit", "--quiet", "--no-verify", "-m", title], { cwd: dir, env: identityEnv(job) });
      }
      const ahead = Number((await git(["rev-list", "--count", `refs/remotes/origin/${startRef}..HEAD`], { cwd: dir })).trim());
      if (ahead === 0) {
        return { status: "failed", error: "The agent finished without changing any files", summary: result.summary, costUsd: result.costUsd };
      }

      log(`\nPushing ${ahead} commit${ahead === 1 ? "" : "s"} to ${job.branch}\n`);
      await git([...authArgs(job), "push", "--quiet", url, `HEAD:refs/heads/${job.branch}`], { cwd: dir, secrets: [job.token] });
      const sha = (await git(["rev-parse", "HEAD"], { cwd: dir })).trim();
      return { status: "succeeded", summary: result.summary, commitSha: sha, costUsd: result.costUsd };
    });
  } catch (error) {
    return failure(ctx, error);
  }
}

// Split: read the code (read-only) and propose sub-issues, or none.
export async function runSplitJob(job: JobSpec, ctx: JobContext): Promise<JobOutcome> {
  const maxSubtasks = ctx.split.require_approval ? ctx.split.max_subtasks : undefined;
  const allowSplit = ctx.split.max_depth >= 1;
  if (!allowSplit) ctx.log("Splitting is turned off on this runner (max_depth = 0); planning only\n");
  try {
    return await inWorktree(job, ctx, job.baseBranch, false, async (dir) => {
      const result = await ctx.adapter.plan({
        cwd: dir,
        prompt: planPrompt(job, ctx.instructions, allowSplit ? ctx.split.max_subtasks : 0),
        resume: null,
        env: { ...process.env },
        signal: ctx.signal,
        log: ctx.log,
        onSpawn: ctx.onSpawn,
      });
      if (ctx.signal.aborted) return { status: "canceled" };
      if (result.error) return { status: "failed", error: result.error, costUsd: result.costUsd };
      return { status: "succeeded", summary: result.text, maxSubtasks, costUsd: result.costUsd };
    });
  } catch (error) {
    return failure(ctx, error);
  }
}

const CONFLICT_MARKER = /^(<{7}|>{7}) /m;

// Resolve: merge the sub-issue's branch into its parent's, have the agent fix the conflicts,
// then commit the merge and push the parent's branch.
export async function runResolveJob(job: JobSpec, ctx: JobContext): Promise<JobOutcome> {
  const { source, target } = job.resolve!;
  const url = `${ctx.serverUrl}${job.clonePath}`;
  const env = identityEnv(job);
  try {
    return await inWorktree(job, ctx, target, true, async (dir) => {
      ctx.log(`Merging ${source} into ${target}\n`);
      let conflicted: string[] = [];
      try {
        await git(["merge", "--no-ff", "--no-edit", "--no-commit", `refs/remotes/origin/${source}`], { cwd: dir, env });
      } catch (e) {
        if (!(e instanceof GitCommandError)) throw e;
        conflicted = (await git(["diff", "--name-only", "--diff-filter=U"], { cwd: dir })).split("\n").filter(Boolean);
        if (conflicted.length === 0) throw e;
      }

      if (conflicted.length) {
        ctx.log(`Conflicts in ${conflicted.join(", ")}\n\n`);
        const result = await ctx.adapter.implement({
          cwd: dir,
          prompt: resolvePrompt(job, conflicted, ctx.instructions),
          env: { ...process.env, ...env },
          signal: ctx.signal,
          log: ctx.log,
          onSpawn: ctx.onSpawn,
        });
        if (ctx.signal.aborted) return { status: "canceled" };
        if (result.error) return { status: "failed", error: result.error };
        const left = conflicted.filter((file) => {
          try {
            return CONFLICT_MARKER.test(readFileSync(join(dir, file), "utf8"));
          } catch {
            return false;
          }
        });
        if (left.length) return { status: "failed", error: `Conflict markers are still in ${left.join(", ")}` };
      }

      await git(["add", "--all"], { cwd: dir });
      const subject = job.issue ? `Merge #${job.issue.number} ${job.issue.title} into ${target}` : `Merge ${source} into ${target}`;
      await git(["commit", "--quiet", "--no-verify", "-m", subject], { cwd: dir, env });
      ctx.log(`\nPushing the merge to ${target}\n`);
      await git([...authArgs(job), "push", "--quiet", url, `HEAD:refs/heads/${target}`], { cwd: dir, secrets: [job.token] });
      const sha = (await git(["rev-parse", "HEAD"], { cwd: dir })).trim();
      return { status: "succeeded", summary: conflicted.length ? `Resolved conflicts in ${conflicted.join(", ")}` : "Merged cleanly", commitSha: sha };
    });
  } catch (error) {
    return failure(ctx, error);
  }
}
