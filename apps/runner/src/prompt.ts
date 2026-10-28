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

const REPLY_FORMAT = `Reply in exactly this format, with all the tags:

<message>
What the user sees, in markdown: a short reaction to their last answer, then ONE question.
</message>
<plan>
The complete plan so far, in markdown, rewritten in full every time: the goal, decisions
made, how it fits the existing code (name files and modules), and open questions.
</plan>`;

const FINALIZE_FORMAT = `The user is ready to cut issues. Reply in exactly this format, with all the tags:

<message>
A short wrap-up in markdown: what the issues cover and anything still open.
</message>
<plan>
The final plan in markdown.
</plan>
<issues>
A JSON array of issues, in the order they should be done. Each issue is one focused job for a
coding agent, small enough to review as one merge request:
[{"key": "short-id", "title": "...", "body": "markdown: what to build, where in the code, and how to tell it's done", "labels": ["..."], "dependsOn": ["keys of issues that must be done first"]}]
</issues>`;

const workshopRules = (job: JobSpec) => `You're running a plan workshop in Cohort for the project ${job.project}. The user has an
idea; your job is to interview them until it's a build plan that coding agents can carry out
as a set of issues.

The current directory is a read-only checkout of ${job.baseBranch}. Read the code to ground
your questions in what's really there. Don't change any files.

How to interview:
- Ask exactly one question per reply: the most important open question.
- Give your recommended answer and the reason, so the user can just agree.
- Push back on vague, contradictory or risky answers and ask for specifics.
- Prefer decisions over options. When you have enough for a solid plan, say so and suggest
  proposing issues.`;

// Instructions for one workshop turn. `fresh` means the agent has no session to resume, so it
// gets the full background and transcript.
export function workshopPrompt(job: JobSpec, runnerInstructions: string, fresh: boolean) {
  const turn = job.workshop!;
  const format = turn.mode === "finalize" ? FINALIZE_FORMAT : REPLY_FORMAT;
  const parts: string[] = [];

  if (fresh) {
    parts.push(workshopRules(job));
    if (job.context.trim()) parts.push(`Project instructions:\n\n${job.context.trim()}`);
    if (runnerInstructions.trim()) parts.push(`Runner instructions:\n\n${runnerInstructions.trim()}`);
    const earlier = turn.transcript.slice(0, -1).filter((m) => m.role !== "system");
    if (earlier.length) {
      parts.push(
        `The conversation so far:\n\n${earlier.map((m) => `${m.role === "user" ? "User" : "You"}: ${m.body}`).join("\n\n")}`,
      );
    }
    if (turn.plan.trim()) parts.push(`The plan so far:\n\n${turn.plan.trim()}`);
  }

  if (turn.mode === "finalize") parts.push(format);
  else {
    parts.push(fresh && turn.transcript.length <= 1 ? `The user's idea:\n\n${turn.message}` : `The user replied:\n\n${turn.message}`);
    parts.push(format);
  }
  return parts.join("\n\n");
}
