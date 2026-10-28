import { and, desc, eq, inArray } from "drizzle-orm";
import {
  issueComments,
  issueLabels,
  issues,
  labels,
  jobs,
  mergeRequests,
  projects,
  runners,
  users,
  workspaces,
  type Db,
} from "@cohort/db";
import type { Job, JobSpec } from "@cohort/shared";
import { botEmail, findBot } from "../bots.ts";
import { branchSha, defaultBranch, repoDir } from "../git/repo.ts";
import { slugify } from "../slug.ts";
import { createMergeRequest } from "../mrs/service.ts";
import type { JobLogs } from "./logs.ts";

type JobRow = typeof jobs.$inferSelect;
type IssueRow = typeof issues.$inferSelect;

export class JobError extends Error {}

export interface Dispatcher {
  dispatch(): void;
  cancel(job: JobRow): boolean;
  waitingReason(agentType: JobRow["agentType"]): string | null;
}

export const ACTIVE = ["queued", "running"] as const;

export class Jobs {
  dispatcher: Dispatcher | null = null;

  constructor(
    readonly db: Db,
    readonly reposRoot: string,
    readonly logs: JobLogs,
  ) {}

  private projectPath(projectId: number) {
    const row = this.db
      .select({ workspace: workspaces.slug, project: projects.slug, context: projects.runnerContext })
      .from(projects)
      .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
      .where(eq(projects.id, projectId))
      .get();
    if (!row) throw new JobError("Project not found");
    return row;
  }

  get(id: number) {
    return this.db.select().from(jobs).where(eq(jobs.id, id)).get();
  }

  activeForIssue(issueId: number) {
    return this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.issueId, issueId), inArray(jobs.status, [...ACTIVE])))
      .get();
  }

  // Throws when an agent couldn't work on this project yet.
  async checkAssignable(projectId: number) {
    const { workspace, project } = this.projectPath(projectId);
    if (!(await defaultBranch(repoDir(this.reposRoot, workspace, project)))) {
      throw new JobError("Push at least one commit before assigning an agent");
    }
  }

  // Starts or cancels agent work after an issue's assignee changed.
  async assigneeChanged(issue: IssueRow, previousAssigneeId: number | null) {
    if (issue.assigneeId === previousAssigneeId) return;
    if (previousAssigneeId !== null && findBot(this.db, previousAssigneeId)) {
      const active = this.activeForIssue(issue.id);
      if (active && active.botId === previousAssigneeId) this.cancel(active);
    }
    if (issue.assigneeId !== null && findBot(this.db, issue.assigneeId)) {
      await this.enqueueForIssue(issue, issue.assigneeId);
    }
  }

  // Queues an implement job for `issue` on `botId`'s agent, unless one is already active.
  async enqueueForIssue(issue: IssueRow, botId: number): Promise<JobRow> {
    const active = this.activeForIssue(issue.id);
    if (active) return active;
    const bot = findBot(this.db, botId);
    if (!bot?.agentType) throw new JobError("That user isn't an agent");

    const { workspace, project } = this.projectPath(issue.projectId);
    const base = await defaultBranch(repoDir(this.reposRoot, workspace, project));
    if (!base) throw new JobError("Push at least one commit before assigning an agent");

    // Retries keep working on the branch earlier jobs for this issue used.
    const previous = this.db
      .select({ branch: jobs.branch })
      .from(jobs)
      .where(eq(jobs.issueId, issue.id))
      .orderBy(desc(jobs.id))
      .get();
    const branch = previous?.branch ?? `cohort/${issue.number}-${slugify(issue.title).slice(0, 40) || "issue"}`;

    const row = this.db
      .insert(jobs)
      .values({
        projectId: issue.projectId,
        issueId: issue.id,
        kind: "implement",
        botId: bot.id,
        agentType: bot.agentType,
        branch,
        baseBranch: base,
      })
      .returning()
      .get();
    this.logs.append(row.id, `Queued for ${bot.username}\n`);
    this.dispatcher?.dispatch();
    return row;
  }

  async retry(job: JobRow): Promise<JobRow> {
    if (job.status === "queued" || job.status === "running") throw new JobError("This job is still active");
    const issue = job.issueId ? this.db.select().from(issues).where(eq(issues.id, job.issueId)).get() : undefined;
    if (!issue) throw new JobError("The issue for this job no longer exists");
    const next = await this.enqueueForIssue(issue, job.botId);
    this.setIssueStatus(issue.id, "in_progress");
    return next;
  }

  cancel(job: JobRow) {
    if (job.status === "queued") {
      this.finish(job.id, { status: "canceled" });
      return;
    }
    if (job.status === "running") {
      // Ask the runner; if it's gone, cancel right away.
      if (!this.dispatcher?.cancel(job)) this.finish(job.id, { status: "canceled" });
    }
  }

  // Builds what the runner needs for `job`. `token` is the job's git credential.
  spec(job: JobRow, token: string): JobSpec {
    const { workspace, project, context } = this.projectPath(job.projectId);
    const bot = this.db.select().from(users).where(eq(users.id, job.botId)).get()!;
    const issue = job.issueId ? this.db.select().from(issues).where(eq(issues.id, job.issueId)).get() : undefined;
    const labelNames = issue
      ? this.db
          .select({ name: labels.name })
          .from(issueLabels)
          .innerJoin(labels, eq(labels.id, issueLabels.labelId))
          .where(eq(issueLabels.issueId, issue.id))
          .orderBy(labels.name)
          .all()
          .map((l) => l.name)
      : [];
    return {
      id: job.id,
      kind: job.kind,
      agent: job.agentType,
      project: `${workspace}/${project}`,
      clonePath: `/${workspace}/${project}.git`,
      token,
      branch: job.branch,
      baseBranch: job.baseBranch,
      branchExists: false,
      issue: issue ? { number: issue.number, title: issue.title, body: issue.body, labels: labelNames } : null,
      context,
      bot: { name: bot.username, email: botEmail(bot.username) },
    };
  }

  async branchExists(job: JobRow) {
    const { workspace, project } = this.projectPath(job.projectId);
    return (await branchSha(repoDir(this.reposRoot, workspace, project), job.branch)) !== null;
  }

  // --- Runner events ------------------------------------------------------------------------

  assigned(jobId: number, runnerId: number, tokenHash: string) {
    this.db
      .update(jobs)
      .set({ status: "running", runnerId, tokenHash, startedAt: new Date() })
      .where(eq(jobs.id, jobId))
      .run();
    const job = this.get(jobId)!;
    const runner = this.db.select({ name: runners.name }).from(runners).where(eq(runners.id, runnerId)).get();
    this.logs.append(jobId, `Assigned to runner ${runner?.name ?? runnerId}\n`);
    if (job.issueId) this.setIssueStatus(job.issueId, "in_progress");
    this.emitStatus(job);
  }

  requeue(jobId: number, reason: string) {
    this.db
      .update(jobs)
      .set({ status: "queued", runnerId: null, tokenHash: null, startedAt: null })
      .where(eq(jobs.id, jobId))
      .run();
    this.logs.append(jobId, `Back in the queue: ${reason}\n`);
    this.emitStatus(this.get(jobId)!);
  }

  log(jobId: number, text: string) {
    this.logs.append(jobId, text);
  }

  // Records the outcome, opens or updates the merge request, and updates the issue.
  async finish(
    jobId: number,
    result: { status: "succeeded" | "failed" | "canceled"; summary?: string; error?: string; commitSha?: string },
  ) {
    const job = this.get(jobId);
    if (!job || (job.status !== "queued" && job.status !== "running")) return;
    this.db
      .update(jobs)
      .set({
        status: result.status,
        summary: result.summary ?? null,
        error: result.error ?? null,
        commitSha: result.commitSha ?? null,
        tokenHash: null,
        finishedAt: new Date(),
      })
      .where(eq(jobs.id, jobId))
      .run();
    this.logs.append(jobId, `\nJob ${result.status}${result.error ? `: ${result.error}` : ""}\n`);

    const issue = job.issueId ? this.db.select().from(issues).where(eq(issues.id, job.issueId)).get() : undefined;
    if (issue && result.status === "succeeded") {
      const mr = await this.openMergeRequest(job, issue, result.summary ?? "");
      this.db.update(jobs).set({ mergeRequestId: mr.id }).where(eq(jobs.id, jobId)).run();
      this.setIssueStatus(issue.id, "review");
      this.comment(issue.id, job.botId, `Opened !${mr.number} from \`${job.branch}\`.${result.summary ? `\n\n${result.summary}` : ""}`);
    } else if (issue && result.status === "failed") {
      this.setIssueStatus(issue.id, "blocked");
      this.comment(issue.id, job.botId, `Job #${job.id} failed: ${result.error ?? "unknown error"}`);
    } else if (issue && result.status === "canceled") {
      this.setIssueStatus(issue.id, "todo");
    }
    this.emitStatus(this.get(jobId)!);
    this.dispatcher?.dispatch();
  }

  private async openMergeRequest(job: JobRow, issue: IssueRow, summary: string) {
    const existing = this.db
      .select()
      .from(mergeRequests)
      .where(
        and(
          eq(mergeRequests.projectId, job.projectId),
          eq(mergeRequests.sourceBranch, job.branch),
          eq(mergeRequests.status, "open"),
        ),
      )
      .get();
    if (existing) return existing;
    return createMergeRequest(this.db, {
      projectId: job.projectId,
      authorId: job.botId,
      title: `Resolve "${issue.title}"`,
      description: `Closes #${issue.number}${summary ? `\n\n${summary}` : ""}`,
      sourceBranch: job.branch,
      targetBranch: job.baseBranch,
      issueId: issue.id,
    });
  }

  private setIssueStatus(issueId: number, status: IssueRow["status"]) {
    this.db.update(issues).set({ status, updatedAt: new Date() }).where(eq(issues.id, issueId)).run();
  }

  private comment(issueId: number, authorId: number, body: string) {
    this.db.insert(issueComments).values({ issueId, authorId, body }).run();
  }

  private emitStatus(job: JobRow) {
    this.logs.emit(`status:${job.id}`, this.toApi(job));
  }

  // --- API shape ----------------------------------------------------------------------------

  toApi(job: JobRow): Job {
    const { workspace, project } = this.projectPath(job.projectId);
    const bot = this.db.select({ username: users.username }).from(users).where(eq(users.id, job.botId)).get();
    const issue = job.issueId ? this.db.select().from(issues).where(eq(issues.id, job.issueId)).get() : undefined;
    const runner = job.runnerId
      ? this.db.select({ name: runners.name }).from(runners).where(eq(runners.id, job.runnerId)).get()
      : undefined;
    const mr = job.mergeRequestId
      ? this.db.select({ number: mergeRequests.number }).from(mergeRequests).where(eq(mergeRequests.id, job.mergeRequestId)).get()
      : undefined;
    return {
      id: job.id,
      project: `${workspace}/${project}`,
      kind: job.kind,
      issue: issue ? { number: issue.number, title: issue.title, status: issue.status } : null,
      bot: bot?.username ?? "",
      agentType: job.agentType,
      status: job.status,
      runner: runner?.name ?? null,
      branch: job.branch,
      baseBranch: job.baseBranch,
      summary: job.summary,
      error: job.error,
      commitSha: job.commitSha,
      mergeRequest: mr?.number ?? null,
      waitingReason: job.status === "queued" ? (this.dispatcher?.waitingReason(job.agentType) ?? null) : null,
      createdAt: job.createdAt.toISOString(),
      startedAt: job.startedAt?.toISOString() ?? null,
      finishedAt: job.finishedAt?.toISOString() ?? null,
    };
  }

  list(where: { projectId?: number; issueId?: number; mergeRequestId?: number }, limit = 50): Job[] {
    const conditions = [];
    if (where.projectId !== undefined) conditions.push(eq(jobs.projectId, where.projectId));
    if (where.issueId !== undefined) conditions.push(eq(jobs.issueId, where.issueId));
    if (where.mergeRequestId !== undefined) conditions.push(eq(jobs.mergeRequestId, where.mergeRequestId));
    return this.db
      .select()
      .from(jobs)
      .where(and(...conditions))
      .orderBy(desc(jobs.id))
      .limit(limit)
      .all()
      .map((j) => this.toApi(j));
  }
}
