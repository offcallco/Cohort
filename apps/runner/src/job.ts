import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { JobSpec } from "@cohort/shared";
import type { AgentAdapter } from "./agents/index.ts";
import { git, KeyedLock } from "./git.ts";
import { implementPrompt } from "./prompt.ts";

export interface JobContext {
  serverUrl: string;
  dataDir: string;
  instructions: string;
  adapter: AgentAdapter;
  signal: AbortSignal;
  log: (text: string) => void;
  locks: KeyedLock;
}

export interface JobOutcome {
  status: "succeeded" | "failed" | "canceled";
  summary?: string;
  error?: string;
  commitSha?: string;
}

// Runs an implement job: check out a worktree, run the agent, commit, push the branch.
export async function runImplementJob(job: JobSpec, ctx: JobContext): Promise<JobOutcome> {
  const { log, signal } = ctx;
  const url = `${ctx.serverUrl}${job.clonePath}`;
  // Job token only: no credential helpers, so nothing stored on this machine is used.
  const auth = ["-c", "credential.helper=", "-c", `http.extraHeader=Authorization: Bearer ${job.token}`];
  const secrets = [job.token];
  const cache = join(ctx.dataDir, "cache", `${job.project}.git`);
  const worktree = join(ctx.dataDir, "worktrees", `job-${job.id}`);
  const localBranch = `cohort-job-${job.id}`;
  const startPoint = `refs/remotes/origin/${job.branchExists ? job.branch : job.baseBranch}`;
  const identity = {
    GIT_AUTHOR_NAME: job.bot.name,
    GIT_AUTHOR_EMAIL: job.bot.email,
    GIT_COMMITTER_NAME: job.bot.name,
    GIT_COMMITTER_EMAIL: job.bot.email,
  };

  try {
    log(`Fetching ${job.project}\n`);
    await ctx.locks.run(cache, async () => {
      if (!existsSync(cache)) {
        mkdirSync(cache, { recursive: true });
        await git(["init", "--bare", "--quiet", cache]);
      }
      await git(
        ["--git-dir", cache, ...auth, "fetch", "--prune", "--quiet", url, "+refs/heads/*:refs/remotes/origin/*"],
        { secrets },
      );
      rmSync(worktree, { recursive: true, force: true });
      await git(["--git-dir", cache, "worktree", "prune"]);
      await git(["--git-dir", cache, "worktree", "add", "--quiet", "--force", "-B", localBranch, worktree, startPoint]);
    });
    log(`Checked out ${job.branchExists ? job.branch : `${job.baseBranch} as ${job.branch}`}\n\n`);
    if (signal.aborted) return { status: "canceled" };

    const prompt = implementPrompt(job, ctx.instructions);
    const result = await ctx.adapter.implement({
      cwd: worktree,
      prompt,
      // The agent's own commits use the bot identity too.
      env: { ...process.env, ...identity },
      signal,
      log,
    });
    if (signal.aborted) return { status: "canceled" };
    if (result.error) return { status: "failed", error: result.error, summary: result.summary };

    const dirty = (await git(["status", "--porcelain"], { cwd: worktree })).trim();
    if (dirty) {
      const title = job.issue ? `${job.issue.title} (#${job.issue.number})` : `Changes from job ${job.id}`;
      await git(["add", "--all"], { cwd: worktree });
      await git(["commit", "--quiet", "--no-verify", "-m", title], { cwd: worktree, env: identity });
    }
    const ahead = Number((await git(["rev-list", "--count", `${startPoint}..HEAD`], { cwd: worktree })).trim());
    if (ahead === 0) return { status: "failed", error: "The agent finished without changing any files", summary: result.summary };

    log(`\nPushing ${ahead} commit${ahead === 1 ? "" : "s"} to ${job.branch}\n`);
    await git([...auth, "push", "--quiet", url, `HEAD:refs/heads/${job.branch}`], { cwd: worktree, secrets });
    const sha = (await git(["rev-parse", "HEAD"], { cwd: worktree })).trim();
    return { status: "succeeded", summary: result.summary, commitSha: sha };
  } catch (error) {
    if (signal.aborted) return { status: "canceled" };
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  } finally {
    await ctx.locks
      .run(cache, async () => {
        if (!existsSync(cache)) return;
        await git(["--git-dir", cache, "worktree", "remove", "--force", worktree]).catch(() => undefined);
        await git(["--git-dir", cache, "branch", "-D", localBranch]).catch(() => undefined);
      })
      .catch(() => undefined);
    rmSync(worktree, { recursive: true, force: true });
  }
}
