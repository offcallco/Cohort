import { and, desc, eq, inArray } from "drizzle-orm";
import {
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
import type { Job, JobSpec, WorkshopTurn } from "@cohort/shared";
import { botEmail } from "../bots.ts";
import { branchSha, defaultBranch, repoDir } from "../git/repo.ts";
import { IssueFlow } from "./issueFlow.ts";
import type { Pipelines } from "../pipelines/service.ts";
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

export interface JobResult {
  status: "succeeded" | "failed" | "canceled";
  summary?: string;
  error?: string;
  commitSha?: string;
  sessionId?: string;
  maxSubtasks?: number;
  costUsd?: number;
}

// Implemented by the workshop service, which owns what workshop jobs mean.
export interface WorkshopHooks {
  spec(job: JobRow): WorkshopTurn;
  finished(job: JobRow, result: JobResult): Promise<void>;
  preferredRunner(job: JobRow): number | null;
  retry(job: JobRow): JobRow;
}

export class Jobs {
  dispatcher: Dispatcher | null = null;
  workshops: WorkshopHooks | null = null;
  pipelines: Pipelines | null = null;
  // Issue jobs: splitting, sub-issues, dependencies and merge requests.
  readonly flow: IssueFlow;

  constructor(
    readonly db: Db,
    readonly reposRoot: string,
    readonly logs: JobLogs,
  ) {
    this.flow = new IssueFlow(this);
  }

  projectPath(projectId: number) {
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
  assigneeChanged(issue: IssueRow, previousAssigneeId: number | null) {
    return this.flow.assigneeChanged(issue, previousAssigneeId);
  }

  async retry(job: JobRow): Promise<JobRow> {
    if (job.status === "queued" || job.status === "running") throw new JobError("This job is still active");
    if (job.kind === "workshop") return this.workshops!.retry(job);
    return this.flow.retry(job);
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
      issue: issue ? { number: issue.number, title: issue.title, body: issue.body, labels: labelNames, plan: issue.plan } : null,
      instruction: job.instruction,
      context,
      bot: { name: bot.username, email: botEmail(bot.username) },
      workshop: job.kind === "workshop" ? this.workshops!.spec(job) : undefined,
      resolve: job.kind === "resolve" ? { source: job.baseBranch, target: job.branch } : undefined,
    };
  }

  preferredRunner(job: JobRow) {
    return job.kind === "workshop" ? (this.workshops?.preferredRunner(job) ?? null) : null;
  }

  // Why a queued job can't start yet regardless of runners, e.g. unfinished dependencies.
  blockedReason(job: JobRow) {
    return this.flow.blockedReason(job);
  }

  async branchExists(job: JobRow) {
    if (!job.branch || job.kind !== "implement") return false;
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
    if (job.issueId && job.kind !== "workshop") this.setIssueStatus(job.issueId, "in_progress");
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
  async finish(jobId: number, result: JobResult) {
    const job = this.get(jobId);
    if (!job || (job.status !== "queued" && job.status !== "running")) return;
    this.db
      .update(jobs)
      .set({
        status: result.status,
        summary: result.summary ?? null,
        error: result.error ?? null,
        commitSha: result.commitSha ?? null,
        costUsd: result.costUsd ?? null,
        tokenHash: null,
        finishedAt: new Date(),
      })
      .where(eq(jobs.id, jobId))
      .run();
    this.logs.append(jobId, `\nJob ${result.status}${result.error ? `: ${result.error}` : ""}\n`);

    if (job.kind === "workshop") {
      await this.workshops?.finished({ ...job, runnerId: job.runnerId }, result);
      this.emitStatus(this.get(jobId)!);
      this.dispatcher?.dispatch();
      return;
    }

    try {
      await this.flow.finished(job, result);
    } catch (e) {
      this.logs.append(jobId, `Couldn't finish up after the job: ${e instanceof Error ? e.message : e}\n`);
    }
    this.emitStatus(this.get(jobId)!);
    this.dispatcher?.dispatch();
  }

  private setIssueStatus(issueId: number, status: IssueRow["status"]) {
    this.db.update(issues).set({ status, updatedAt: new Date() }).where(eq(issues.id, issueId)).run();
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
      workshop: job.workshopId,
      bot: bot?.username ?? "",
      agentType: job.agentType,
      status: job.status,
      runner: runner?.name ?? null,
      branch: job.branch,
      baseBranch: job.baseBranch,
      summary: job.summary,
      error: job.error,
      commitSha: job.commitSha,
      costUsd: job.costUsd,
      mergeRequest: mr?.number ?? null,
      waitingReason:
        job.status === "queued" ? (this.blockedReason(job) ?? this.dispatcher?.waitingReason(job.agentType) ?? null) : null,
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
