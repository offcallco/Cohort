import { and, eq, inArray } from "drizzle-orm";
import { issueComments, issueDependencies, issueLabels, issues, jobs, labels, mergeRequests, users, type Db } from "@cohort/db";
import type { ProposedIssue } from "@cohort/shared";
import { botEmail, findBot } from "../bots.ts";
import {
  branchSha,
  createBranch,
  defaultBranch,
  deleteBranch,
  GitError,
  mergeBranches,
  MergeConflictError,
  repoDir,
} from "../git/repo.ts";
import { createIssue } from "../issues/service.ts";
import { createMergeRequest } from "../mrs/service.ts";
import { slugify } from "../slug.ts";
import { orderIssues, parseReply, parseSubtasks } from "../workshops/parse.ts";
import { JobError, type JobResult, type Jobs } from "./service.ts";

type JobRow = typeof jobs.$inferSelect;
type IssueRow = typeof issues.$inferSelect;

// Issues with this label are done as one job, without asking the agent to split them.
export const NO_SPLIT_LABEL = "no-split";

// What happens to issues as agents work on them:
//
// - An issue whose dependencies aren't done waits in the queue.
// - Assigning a parent whose sub-issues came from a person or a workshop assigns the
//   sub-issues instead; they run in dependency order and the parent is done when they are.
// - Any other issue first gets a "split" job. If the agent proposes two or more sub-issues,
//   they're created ("split" origin), run on branches cut from the issue's branch, and are
//   merged back into it as they finish. A merge conflict gets a "resolve" job. When all are
//   merged, one merge request opens for the issue. Splits over the runner's max_subtasks
//   wait for approval. Otherwise the issue is implemented directly and gets its own MR.
export class IssueFlow {
  constructor(private readonly jobs: Jobs) {}

  private get db(): Db {
    return this.jobs.db;
  }

  private issue(id: number) {
    return this.db.select().from(issues).where(eq(issues.id, id)).get();
  }

  private children(issueId: number) {
    return this.db.select().from(issues).where(eq(issues.parentId, issueId)).orderBy(issues.number).all();
  }

  private gitDir(projectId: number) {
    const { workspace, project } = this.jobs.projectPath(projectId);
    return repoDir(this.jobs.reposRoot, workspace, project);
  }

  private hasLabel(issueId: number, name: string) {
    return !!this.db
      .select({ id: labels.id })
      .from(issueLabels)
      .innerJoin(labels, eq(labels.id, issueLabels.labelId))
      .where(and(eq(issueLabels.issueId, issueId), eq(labels.name, name)))
      .get();
  }

  private setStatus(issueId: number, status: IssueRow["status"]) {
    this.db.update(issues).set({ status, updatedAt: new Date() }).where(eq(issues.id, issueId)).run();
  }

  private comment(issueId: number, authorId: number, body: string) {
    this.db.insert(issueComments).values({ issueId, authorId, body }).run();
    this.db.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, issueId)).run();
  }

  private botName(botId: number) {
    return this.db.select({ username: users.username }).from(users).where(eq(users.id, botId)).get()!.username;
  }

  private queue(
    issue: IssueRow,
    kind: "implement" | "split" | "resolve",
    botId: number,
    branch: string,
    baseBranch: string,
    instruction: string | null = null,
  ) {
    const bot = findBot(this.db, botId)!;
    const row = this.db
      .insert(jobs)
      .values({ projectId: issue.projectId, issueId: issue.id, kind, botId, agentType: bot.agentType!, branch, baseBranch, instruction })
      .returning()
      .get();
    const what = { implement: "Queued", split: "Queued to plan the work", resolve: "Queued to resolve a merge conflict" }[kind];
    this.jobs.logs.append(row.id, `${what} for ${bot.username}\n`);
    this.jobs.dispatcher?.dispatch();
    return row;
  }

  // Branch for an issue's work, chosen once and reused by retries.
  private branchFor(issue: IssueRow): string {
    if (issue.branch) return issue.branch;
    const previous = this.db
      .select({ branch: jobs.branch })
      .from(jobs)
      .where(and(eq(jobs.issueId, issue.id), inArray(jobs.kind, ["implement", "split"])))
      .orderBy(jobs.id)
      .get();
    const name = `${issue.number}-${slugify(issue.title).slice(0, 40) || "issue"}`;
    let branch = previous?.branch ?? `cohort/${name}`;
    if (!previous && issue.origin === "split") {
      // Git can't have both "a" and "a/b" as branches, so sub-issues use "a--b".
      const parent = this.issue(issue.parentId!)!;
      branch = `${parent.branch}--${name}`;
    }
    this.db.update(issues).set({ branch }).where(eq(issues.id, issue.id)).run();
    return branch;
  }

  // --- Starting work ------------------------------------------------------------------------

  // Starts `botId`'s agent on `issue`. Returns the queued job, or null when the work went to
  // sub-issues instead.
  async start(issue: IssueRow, botId: number): Promise<JobRow | null> {
    const active = this.jobs.activeForIssue(issue.id);
    if (active) return active;
    const bot = findBot(this.db, botId);
    if (!bot?.agentType) throw new JobError("That user isn't an agent");
    const base = await defaultBranch(this.gitDir(issue.projectId));
    if (!base) throw new JobError("Push at least one commit before assigning an agent");

    const kids = this.children(issue.id);
    if (kids.some((k) => k.origin === "split")) return this.resumeSplit(issue, kids, botId);
    if (kids.length > 0) return this.assignChildren(issue, kids, botId);

    const branch = this.branchFor(issue);
    if (issue.origin === "split") {
      const parent = this.issue(issue.parentId!)!;
      return this.queue(issue, "implement", botId, branch, parent.branch!);
    }
    // Plan first, unless there's already a plan to follow or the issue opts out.
    const planned = issue.plan !== null && (issue.planStatus === "approved" || issue.planStatus === "auto");
    const kind = planned || this.hasLabel(issue.id, NO_SPLIT_LABEL) ? "implement" : "split";
    return this.queue(issue, kind, botId, branch, base);
  }

  // A parent with sub-issues from a person or workshop: hand each open one to the agent.
  private async assignChildren(parent: IssueRow, kids: IssueRow[], botId: number) {
    const open = kids.filter((k) => k.status !== "done");
    for (const kid of open) {
      if (kid.assigneeId !== botId) {
        this.db.update(issues).set({ assigneeId: botId, updatedAt: new Date() }).where(eq(issues.id, kid.id)).run();
      }
      await this.start(this.issue(kid.id)!, botId);
    }
    if (open.length) {
      this.setStatus(parent.id, "in_progress");
      this.comment(parent.id, botId, `Assigned ${open.map((k) => `#${k.number}`).join(", ")} to ${this.botName(botId)}. They start as their dependencies are done.`);
    }
    await this.completeParent(parent);
    return null;
  }

  // An issue that was already split (e.g. retried): restart its unfinished sub-issues.
  private async resumeSplit(parent: IssueRow, kids: IssueRow[], botId: number) {
    for (const kid of kids.filter((k) => k.status !== "done" && !this.jobs.activeForIssue(k.id))) {
      await this.start(kid, botId);
    }
    this.setStatus(parent.id, "in_progress");
    await this.completeParent(parent);
    return null;
  }

  // Why a queued job can't start yet, regardless of runners.
  blockedReason(job: JobRow): string | null {
    if (!job.issueId || job.kind === "resolve") return null;
    const open = this.db
      .select({ number: issues.number, status: issues.status })
      .from(issueDependencies)
      .innerJoin(issues, eq(issues.id, issueDependencies.dependsOnId))
      .where(eq(issueDependencies.issueId, job.issueId))
      .all()
      .filter((d) => d.status !== "done");
    return open.length ? `Waiting on ${open.map((d) => `#${d.number}`).join(", ")}` : null;
  }

  async assigneeChanged(issue: IssueRow, previousAssigneeId: number | null) {
    if (issue.assigneeId === previousAssigneeId) return;
    if (previousAssigneeId !== null && findBot(this.db, previousAssigneeId)) {
      const active = this.jobs.activeForIssue(issue.id);
      if (active && active.botId === previousAssigneeId) this.jobs.cancel(active);
      // Sub-issues the agent split off go with it.
      for (const kid of this.children(issue.id).filter((k) => k.origin === "split")) {
        const job = this.jobs.activeForIssue(kid.id);
        if (job) this.jobs.cancel(job);
      }
    }
    if (issue.assigneeId !== null && findBot(this.db, issue.assigneeId)) {
      await this.start(issue, issue.assigneeId);
    }
  }

  async retry(job: JobRow): Promise<JobRow> {
    const issue = job.issueId ? this.issue(job.issueId) : undefined;
    if (!issue) throw new JobError("The issue for this job no longer exists");
    let next: JobRow | null;
    if (job.kind === "resolve") next = this.queue(issue, "resolve", job.botId, job.branch, job.baseBranch);
    else next = await this.start(issue, job.botId);
    this.setStatus(issue.id, "in_progress");
    if (!next) throw new JobError("Restarted the unfinished sub-issues");
    return next;
  }

  // --- Results ------------------------------------------------------------------------------

  async finished(job: JobRow, result: JobResult) {
    const issue = job.issueId ? this.issue(job.issueId) : undefined;
    if (!issue) return;
    if (result.status === "canceled") {
      // Redirected: start again with the person's new instruction.
      if (issue.pendingInstruction) {
        const instruction = issue.pendingInstruction;
        this.db.update(issues).set({ pendingInstruction: null }).where(eq(issues.id, issue.id)).run();
        const kind = job.kind === "resolve" ? "implement" : job.kind === "split" ? "split" : "implement";
        this.queue(issue, kind, job.botId, job.branch, job.baseBranch, instruction);
        this.setStatus(issue.id, "in_progress");
        return;
      }
      this.setStatus(issue.id, "todo");
      return;
    }
    if (result.status === "failed") {
      this.setStatus(issue.id, "blocked");
      this.comment(issue.id, job.botId, `Job #${job.id} failed: ${result.error ?? "unknown error"}`);
      if (issue.origin === "split" && issue.parentId) {
        this.comment(issue.parentId, job.botId, `Sub-issue #${issue.number} is blocked: job #${job.id} failed.`);
      }
      return;
    }
    if (job.kind === "split") return this.planFinished(job, issue, result);
    if (job.kind === "resolve") return this.childMerged(issue, job.botId);
    if (issue.origin === "split") return this.mergeChild(issue, job.botId);
    return this.openMergeRequest(job, issue, result.summary ?? "");
  }

  private async openMergeRequest(job: JobRow, issue: IssueRow, summary: string) {
    const existing = this.db
      .select()
      .from(mergeRequests)
      .where(and(eq(mergeRequests.projectId, issue.projectId), eq(mergeRequests.sourceBranch, job.branch), eq(mergeRequests.status, "open")))
      .get();
    const mr =
      existing ??
      createMergeRequest(this.db, {
        projectId: issue.projectId,
        authorId: job.botId,
        title: `Resolve "${issue.title}"`,
        description: `Closes #${issue.number}${summary ? `\n\n${summary}` : ""}`,
        sourceBranch: job.branch,
        targetBranch: job.baseBranch,
        issueId: issue.id,
      });
    this.db.update(jobs).set({ mergeRequestId: mr.id }).where(eq(jobs.id, job.id)).run();
    this.setStatus(issue.id, "review");
    this.comment(issue.id, job.botId, `Opened !${mr.number} from \`${job.branch}\`.${summary ? `\n\n${summary}` : ""}`);
    // After the issue is updated, so nothing sees the job done but the issue not in review.
    await this.jobs.pipelines?.forMergeRequest(mr);
  }

  // The root task a person assigned waits for them to approve the plan. Workshop issues were
  // planned with the user already, so they carry straight on.
  private needsPlanApproval(issue: IssueRow) {
    return issue.origin === "user" && issue.parentId === null;
  }

  private async planFinished(job: JobRow, issue: IssueRow, result: JobResult) {
    const text = result.summary ?? "";
    const plan = parseReply(text).plan;
    const subtasks = parseSubtasks(text);
    const split = subtasks && subtasks.length >= 2 ? subtasks : null;

    if (this.needsPlanApproval(issue)) {
      this.db
        .update(issues)
        .set({
          plan: plan ?? "_The agent didn't write a plan._",
          planStatus: "pending",
          splitProposal: split ? JSON.stringify({ issues: split, limit: null }) : null,
          status: "review",
          updatedAt: new Date(),
        })
        .where(eq(issues.id, issue.id))
        .run();
      this.comment(
        issue.id,
        job.botId,
        `My plan is ready for your review${split ? `, splitting the work into ${split.length} sub-issues` : ""}. Approve it, ask for changes, or reject it.`,
      );
      return;
    }
    this.db.update(issues).set({ plan, planStatus: "auto" }).where(eq(issues.id, issue.id)).run();
    await this.carryOut(this.issue(issue.id)!, split ?? [], job.botId, result.maxSubtasks);
  }

  // After planning: split into sub-issues, or implement as one job. `approvalLimit` is set when
  // the runner wants splits bigger than that approved.
  private async carryOut(issue: IssueRow, subtasks: ProposedIssue[], botId: number, approvalLimit?: number) {
    const gitDir = this.gitDir(issue.projectId);
    const base = (await defaultBranch(gitDir))!;
    const oneJob = (why: string) => {
      this.comment(issue.id, botId, why);
      this.queue(issue, "implement", botId, this.branchFor(issue), base);
    };
    if (subtasks.length < 2) return oneJob("This is small enough to do as one job.");
    try {
      orderIssues(subtasks);
    } catch (e) {
      return oneJob(`The proposed split didn't hold together (${e instanceof Error ? e.message : e}), so this will be done as one job.`);
    }
    if (approvalLimit !== undefined && subtasks.length > approvalLimit) {
      this.db
        .update(issues)
        .set({ splitProposal: JSON.stringify({ issues: subtasks, limit: approvalLimit }), status: "blocked", updatedAt: new Date() })
        .where(eq(issues.id, issue.id))
        .run();
      this.comment(
        issue.id,
        botId,
        `I'd split this into ${subtasks.length} sub-issues, which is more than this runner's limit of ${approvalLimit}. Approve the split on this issue, or have it done as one job.`,
      );
      return;
    }
    await this.createSubtasks(issue, subtasks, botId);
  }

  // A person's call on a plan waiting for approval.
  async decidePlan(issue: IssueRow, decision: "approve" | "changes" | "reject", note: string, userId: number) {
    if (issue.planStatus !== "pending") throw new JobError("There's no plan waiting for approval");
    const botId = issue.assigneeId;
    if (botId === null || !findBot(this.db, botId)) throw new JobError("Assign the issue to an agent first");
    if (note.trim()) this.comment(issue.id, userId, note.trim());

    if (decision === "approve") {
      const proposal = issue.splitProposal ? (JSON.parse(issue.splitProposal) as { issues: ProposedIssue[] }).issues : [];
      this.db.update(issues).set({ planStatus: "approved", splitProposal: null, status: "in_progress", updatedAt: new Date() }).where(eq(issues.id, issue.id)).run();
      // The person approved the split along with the plan, so no limit applies.
      await this.carryOut(this.issue(issue.id)!, proposal, botId);
    } else if (decision === "changes") {
      if (!note.trim()) throw new JobError("Say what to change, so the agent can revise the plan");
      this.db.update(issues).set({ planStatus: "changes_requested", splitProposal: null, status: "in_progress", updatedAt: new Date() }).where(eq(issues.id, issue.id)).run();
      const base = (await defaultBranch(this.gitDir(issue.projectId)))!;
      this.queue(this.issue(issue.id)!, "split", botId, this.branchFor(issue), base, note.trim());
    } else {
      this.db
        .update(issues)
        .set({ planStatus: "rejected", splitProposal: null, assigneeId: null, status: "todo", updatedAt: new Date() })
        .where(eq(issues.id, issue.id))
        .run();
      this.comment(issue.id, botId, "Plan rejected. I've unassigned myself.");
    }
  }

  // "Request changes" on an issue in review: the agent works again on the same branch.
  async requestChanges(issue: IssueRow, note: string, userId: number) {
    if (!note.trim()) throw new JobError("Say what to change, so the agent can act on it");
    const botId = issue.assigneeId;
    if (botId === null || !findBot(this.db, botId)) throw new JobError("Assign the issue to an agent first");
    if (this.jobs.activeForIssue(issue.id)) throw new JobError("The agent is still working; use Redirect instead");
    if (!issue.branch) throw new JobError("The agent hasn't made any changes yet");
    const gitDir = this.gitDir(issue.projectId);
    if (!(await branchSha(gitDir, issue.branch))) throw new JobError(`The branch ${issue.branch} no longer exists`);
    this.comment(issue.id, userId, `Requested changes:\n\n${note.trim()}`);
    const base = issue.origin === "split" ? this.issue(issue.parentId!)!.branch! : (await defaultBranch(gitDir))!;
    this.setStatus(issue.id, "in_progress");
    return this.queue(issue, "implement", botId, issue.branch, base, note.trim());
  }

  // "Redirect": stop what the agent is doing and start again with a new instruction.
  async redirect(issue: IssueRow, note: string, userId: number) {
    if (!note.trim()) throw new JobError("Give the agent its new instruction");
    const botId = issue.assigneeId;
    if (botId === null || !findBot(this.db, botId)) throw new JobError("Assign the issue to an agent first");
    this.comment(issue.id, userId, `Redirected:\n\n${note.trim()}`);
    const active = this.jobs.activeForIssue(issue.id);
    if (active) {
      // Picked up when the current run reports that it stopped.
      this.db.update(issues).set({ pendingInstruction: note.trim(), updatedAt: new Date() }).where(eq(issues.id, issue.id)).run();
      this.jobs.cancel(active);
      return active;
    }
    const base = (await defaultBranch(this.gitDir(issue.projectId)))!;
    this.setStatus(issue.id, "in_progress");
    return this.queue(issue, "implement", botId, this.branchFor(issue), base, note.trim());
  }

  private async createSubtasks(issue: IssueRow, list: ProposedIssue[], botId: number) {
    const gitDir = this.gitDir(issue.projectId);
    const base = (await defaultBranch(gitDir))!;
    const branch = this.branchFor(issue);
    await createBranch(gitDir, branch, base);

    const bot = this.botName(botId);
    const numbers = new Map<string, number>();
    const created: IssueRow[] = [];
    for (const sub of orderIssues(list)) {
      const row = createIssue(
        this.db,
        issue.projectId,
        botId,
        {
          title: sub.title,
          body: `${sub.body}\n\n---\n_Split from #${issue.number}. Merged into \`${branch}\` when done._`,
          status: "todo",
          labels: sub.labels,
          parent: issue.number,
          dependsOn: sub.dependsOn.map((key) => numbers.get(key)!),
          assignee: bot,
        },
        "split",
      );
      numbers.set(sub.key, row.number);
      created.push(row);
    }
    this.db.update(issues).set({ splitProposal: null, status: "in_progress", updatedAt: new Date() }).where(eq(issues.id, issue.id)).run();
    this.comment(
      issue.id,
      botId,
      `Split into ${created.map((c) => `#${c.number}`).join(", ")}. Each is merged into \`${branch}\` as it's done; you'll get one merge request when they all are.`,
    );
    for (const row of created) await this.start(row, botId);
  }

  async decideSplit(issue: IssueRow, approve: boolean) {
    if (!issue.splitProposal || issue.planStatus === "pending") throw new JobError("There's no split waiting for approval");
    const botId = issue.assigneeId;
    if (botId === null || !findBot(this.db, botId)) throw new JobError("Assign the issue to an agent first");
    const proposal = JSON.parse(issue.splitProposal) as { issues: ProposedIssue[] };
    this.db.update(issues).set({ splitProposal: null, status: "in_progress", updatedAt: new Date() }).where(eq(issues.id, issue.id)).run();
    if (approve) {
      await this.createSubtasks(this.issue(issue.id)!, proposal.issues, botId);
    } else {
      const gitDir = this.gitDir(issue.projectId);
      this.queue(issue, "implement", botId, this.branchFor(issue), (await defaultBranch(gitDir))!);
    }
  }

  // Merges a finished sub-issue's branch into its parent's, or asks the agent to resolve
  // the conflict.
  private async mergeChild(child: IssueRow, botId: number) {
    const parent = this.issue(child.parentId!)!;
    const gitDir = this.gitDir(child.projectId);
    const bot = this.botName(botId);
    const message = `Merge #${child.number} ${child.title} into ${parent.branch}`;
    for (let attempt = 0; ; attempt++) {
      try {
        await mergeBranches(gitDir, parent.branch!, child.branch!, message, { name: bot, email: botEmail(bot) });
        break;
      } catch (e) {
        if (e instanceof MergeConflictError) {
          this.comment(child.id, botId, `This conflicts with \`${parent.branch}\`. Asked ${bot} to resolve it.`);
          this.queue(child, "resolve", botId, parent.branch!, child.branch!);
          return;
        }
        // Another sub-issue merged at the same moment; try again on top of it.
        if (e instanceof GitError && attempt < 3) continue;
        throw e;
      }
    }
    await this.childMerged(child, botId);
  }

  private async childMerged(child: IssueRow, botId: number) {
    const parent = this.issue(child.parentId!)!;
    await deleteBranch(this.gitDir(child.projectId), child.branch!);
    this.setStatus(child.id, "done");
    this.comment(child.id, botId, `Merged into \`${parent.branch}\`.`);
    await this.issueDone(child);
  }

  // Call after an issue is marked done: unblocks issues waiting on it and finishes parents.
  async issueDone(issue: IssueRow) {
    this.jobs.dispatcher?.dispatch();
    if (issue.parentId) {
      const parent = this.issue(issue.parentId);
      if (parent) await this.completeParent(parent);
    }
  }

  private async completeParent(parent: IssueRow) {
    const kids = this.children(parent.id);
    if (kids.length === 0 || kids.some((k) => k.status !== "done")) return;
    const split = kids.some((k) => k.origin === "split");
    if (split && parent.branch) {
      const open = this.db
        .select({ id: mergeRequests.id })
        .from(mergeRequests)
        .where(and(eq(mergeRequests.projectId, parent.projectId), eq(mergeRequests.sourceBranch, parent.branch), eq(mergeRequests.status, "open")))
        .get();
      if (open || parent.status === "review" || parent.status === "done") return;
      const gitDir = this.gitDir(parent.projectId);
      const base = (await defaultBranch(gitDir))!;
      if (!(await branchSha(gitDir, parent.branch))) return;
      const botId = parent.assigneeId ?? kids[0]!.assigneeId!;
      const mr = createMergeRequest(this.db, {
        projectId: parent.projectId,
        authorId: botId,
        title: `Resolve "${parent.title}"`,
        description: `Closes #${parent.number}\n\nDone in ${kids.length} parts:\n${kids.map((k) => `- #${k.number} ${k.title}`).join("\n")}`,
        sourceBranch: parent.branch,
        targetBranch: base,
        issueId: parent.id,
      });
      this.setStatus(parent.id, "review");
      this.comment(parent.id, botId, `All ${kids.length} sub-issues are merged into \`${parent.branch}\`. Opened !${mr.number}.`);
      await this.jobs.pipelines?.forMergeRequest(mr);
      return;
    }
    if (parent.status !== "done") {
      this.setStatus(parent.id, "done");
      await this.issueDone(this.issue(parent.id)!);
    }
  }
}
