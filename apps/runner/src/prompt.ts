import type { JobSpec } from "@cohort/shared";

// The instructions an agent gets for an implement job.
export function implementPrompt(job: JobSpec, runnerInstructions: string) {
  const parts: string[] = [];
  if (job.issue) {
    parts.push(`You're working on issue #${job.issue.number} in ${job.project}: ${job.issue.title}`);
    if (job.issue.labels.length) parts.push(`Labels: ${job.issue.labels.join(", ")}`);
    parts.push(job.issue.body.trim() ? `Issue description:\n\n${job.issue.body.trim()}` : "The issue has no description.");
  }
  if (job.context.trim()) parts.push(`Project instructions:\n\n${job.context.trim()}`);
  if (runnerInstructions.trim()) parts.push(`Runner instructions:\n\n${runnerInstructions.trim()}`);
  parts.push(
    [
      `The current directory is a git checkout of the repo on a branch for this work, based on ${job.branchExists ? job.branch : job.baseBranch}.`,
      "Make the changes the issue asks for. You may commit as you go; anything left uncommitted is committed for you when you finish.",
      "Don't push, and don't switch branches.",
      "When you're done, reply with a short summary of what you changed and anything a reviewer should check.",
    ].join("\n"),
  );
  return parts.join("\n\n");
}
