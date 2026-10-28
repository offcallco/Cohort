import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { mergeRequests, pipelineJobs, pipelines, projects, runners, users, workspaces, type Db } from "@cohort/db";
import type { CiJob, CiJobSpec, PipelineDetail, PipelineSummary } from "@cohort/shared";
import { sha256 } from "../auth.ts";
import { blob, branchSha, repoDir } from "../git/repo.ts";
import type { JobLogs } from "../jobs/logs.ts";
import { CI_CONFIG_FILE, CiConfigError, parseCiConfig } from "./config.ts";

type PipelineRow = typeof pipelines.$inferSelect;
type CiJobRow = typeof pipelineJobs.$inferSelect;
type MrRow = typeof mergeRequests.$inferSelect;

export const CI_TOKEN_PREFIX = "cohort_ci_";
const FINISHED = new Set(["success", "failed", "canceled", "skipped"]);

export class PipelineError extends Error {}

export interface CiDispatcher {
  dispatch(): void;
  cancelCi(job: CiJobRow): boolean;
  ciWaitingReason(): string;
}

export interface CiResult {
  status: "succeeded" | "failed" | "canceled";
  error?: string;
}

export class Pipelines {
  dispatcher: CiDispatcher | null = null;

  constructor(
    private readonly db: Db,
    private readonly reposRoot: string,
    readonly logs: JobLogs,
  ) {}

  private projectPath(projectId: number) {
    return this.db
      .select({ workspace: workspaces.slug, project: projects.slug, row: projects })
      .from(projects)
      .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
      .where(eq(projects.id, projectId))
      .get()!;
  }

  private gitDir(projectId: number) {
    const { workspace, project } = this.projectPath(projectId);
    return repoDir(this.reposRoot, workspace, project);
  }

  get(id: number) {
    return this.db.select().from(pipelines).where(eq(pipelines.id, id)).get();
  }

  getJob(id: number) {
    return this.db.select().from(pipelineJobs).where(eq(pipelineJobs.id, id)).get();
  }

  private jobsOf(pipelineId: number) {
    return this.db.select().from(pipelineJobs).where(eq(pipelineJobs.pipelineId, pipelineId)).orderBy(asc(pipelineJobs.stageIndex), asc(pipelineJobs.id)).all();
  }

  // --- Creating pipelines -------------------------------------------------------------------

  // Creates a pipeline for `sha` from its .cohort-ci.yml, or returns null if it has none.
  // Untrusted pipelines (e.g. for agents' code) wait in "manual" until a person runs them.
  async create(
    projectId: number,
    ref: string,
    sha: string,
    options: { source: PipelineRow["source"]; triggeredById: number; mergeRequestId?: number | null; trusted: boolean },
  ): Promise<PipelineRow | null> {
    const file = await blob(this.gitDir(projectId), sha, CI_CONFIG_FILE);
    if (!file) return null;
    const base = { projectId, ref, sha, source: options.source, triggeredById: options.triggeredById, mergeRequestId: options.mergeRequestId ?? null };

    let config: ReturnType<typeof parseCiConfig>;
    try {
      if (file.content === null) throw new CiConfigError(`${CI_CONFIG_FILE} is too large or binary`);
      config = parseCiConfig(file.content);
    } catch (e) {
      if (!(e instanceof CiConfigError)) throw e;
      return this.db.insert(pipelines).values({ ...base, status: "failed", error: e.message, finishedAt: new Date() }).returning().get();
    }

    const row = this.db.transaction((tx) => {
      const p = tx.insert(pipelines).values({ ...base, status: options.trusted ? "pending" : "manual" }).returning().get();
      tx.insert(pipelineJobs)
        .values(
          config.jobs.map((j) => ({
            pipelineId: p.id,
            name: j.name,
            stage: j.stage,
            stageIndex: j.stageIndex,
            script: JSON.stringify(j.script),
            variables: JSON.stringify(j.variables),
            allowFailure: j.allowFailure,
          })),
        )
        .run();
      return p;
    });
    if (options.trusted) this.advance(row.id);
    return row;
  }

  // After a person pushes: one pipeline per updated branch.
  async afterPush(projectId: number, updates: { ref: string; sha: string }[], userId: number) {
    for (const u of updates) await this.create(projectId, u.ref, u.sha, { source: "push", triggeredById: userId, trusted: true });
  }

  // A pipeline for a merge request's current source commit, unless one already exists.
  // Agents' merge requests wait for a person unless the project runs them automatically.
  async forMergeRequest(mr: MrRow) {
    const sha = await branchSha(this.gitDir(mr.projectId), mr.sourceBranch);
    if (!sha) return null;
    const existing = this.db
      .select()
      .from(pipelines)
      .where(and(eq(pipelines.projectId, mr.projectId), eq(pipelines.ref, mr.sourceBranch), eq(pipelines.sha, sha), ne(pipelines.status, "canceled")))
      .get();
    if (existing) return existing;
    const author = this.db.select({ kind: users.kind }).from(users).where(eq(users.id, mr.authorId)).get();
    const { row: project } = this.projectPath(mr.projectId);
    return this.create(mr.projectId, mr.sourceBranch, sha, {
      source: "merge_request",
      triggeredById: mr.authorId,
      mergeRequestId: mr.id,
      trusted: author?.kind === "human" || project.autoRunAgentPipelines,
    });
  }

  // "Run pipeline" for a branch's current commit.
  async runForBranch(projectId: number, ref: string, userId: number) {
    const sha = await branchSha(this.gitDir(projectId), ref);
    if (!sha) throw new PipelineError(`Branch "${ref}" not found`);
    const row = await this.create(projectId, ref, sha, { source: "web", triggeredById: userId, trusted: true });
    if (!row) throw new PipelineError(`${ref} has no ${CI_CONFIG_FILE}`);
    return row;
  }

  // --- Lifecycle ----------------------------------------------------------------------------

  // Starts a pipeline that was waiting for a person.
  run(p: PipelineRow) {
    if (p.status !== "manual") throw new PipelineError("This pipeline isn't waiting to be started");
    this.db.update(pipelines).set({ status: "pending" }).where(eq(pipelines.id, p.id)).run();
    this.advance(p.id);
  }

  cancel(p: PipelineRow) {
    if (FINISHED.has(p.status)) throw new PipelineError("This pipeline has already finished");
    for (const job of this.jobsOf(p.id)) {
      if (job.status === "created" || job.status === "pending") this.setJob(job.id, { status: "canceled", finishedAt: new Date() });
      else if (job.status === "running" && !this.dispatcher?.cancelCi(job)) this.setJob(job.id, { status: "canceled", finishedAt: new Date(), tokenHash: null });
    }
    this.db.update(pipelines).set({ status: "canceled", finishedAt: new Date() }).where(eq(pipelines.id, p.id)).run();
  }

  async retry(p: PipelineRow, userId: number) {
    if (!FINISHED.has(p.status)) throw new PipelineError("This pipeline is still running");
    const row = await this.create(p.projectId, p.ref, p.sha, { source: p.source, triggeredById: userId, mergeRequestId: p.mergeRequestId, trusted: true });
    if (!row) throw new PipelineError(`That commit has no ${CI_CONFIG_FILE}`);
    return row;
  }

  private setJob(id: number, values: Partial<typeof pipelineJobs.$inferInsert>) {
    this.db.update(pipelineJobs).set(values).where(eq(pipelineJobs.id, id)).run();
  }

  // Moves the pipeline along: starts the next stage when every job before it has passed
  // (allow_failure jobs don't count), skips the rest after a failure, and works out the
  // pipeline's status.
  advance(pipelineId: number) {
    const p = this.get(pipelineId);
    if (!p || p.status === "manual" || FINISHED.has(p.status)) return;
    const all = this.jobsOf(pipelineId);
    const stages = [...new Set(all.map((j) => j.stageIndex))].sort((a, b) => a - b);

    let broken = false;
    for (const stage of stages) {
      const inStage = all.filter((j) => j.stageIndex === stage);
      if (broken) {
        for (const j of inStage.filter((j) => j.status === "created")) {
          this.setJob(j.id, { status: "skipped" });
          j.status = "skipped";
        }
        continue;
      }
      if (inStage.every((j) => FINISHED.has(j.status))) {
        if (inStage.some((j) => (j.status === "failed" && !j.allowFailure) || j.status === "canceled")) broken = true;
        continue;
      }
      for (const j of inStage.filter((j) => j.status === "created")) {
        this.setJob(j.id, { status: "pending" });
        j.status = "pending";
      }
      break;
    }

    const active = all.some((j) => j.status === "pending" || j.status === "running" || j.status === "created");
    if (active) {
      const status = all.some((j) => j.status === "running" || FINISHED.has(j.status)) ? "running" : "pending";
      this.db.update(pipelines).set({ status }).where(eq(pipelines.id, pipelineId)).run();
      this.dispatcher?.dispatch();
      return;
    }
    const failed = all.some((j) => j.status === "failed" && !j.allowFailure);
    const canceled = all.some((j) => j.status === "canceled");
    this.db
      .update(pipelines)
      .set({ status: failed ? "failed" : canceled ? "canceled" : "success", finishedAt: new Date() })
      .where(eq(pipelines.id, pipelineId))
      .run();
  }

  // --- Runner side --------------------------------------------------------------------------

  pendingJobs() {
    return this.db.select().from(pipelineJobs).where(eq(pipelineJobs.status, "pending")).orderBy(asc(pipelineJobs.id)).all();
  }

  spec(job: CiJobRow, token: string): CiJobSpec {
    const p = this.get(job.pipelineId)!;
    const { workspace, project } = this.projectPath(p.projectId);
    return {
      id: job.id,
      pipelineId: p.id,
      project: `${workspace}/${project}`,
      clonePath: `/${workspace}/${project}.git`,
      token,
      ref: p.ref,
      sha: p.sha,
      name: job.name,
      stage: job.stage,
      script: JSON.parse(job.script) as string[],
      variables: {
        ...(JSON.parse(job.variables) as Record<string, string>),
        // GitLab's predefined variables that make sense here.
        CI: "true",
        COHORT_CI: "true",
        CI_PIPELINE_ID: String(p.id),
        CI_JOB_ID: String(job.id),
        CI_JOB_NAME: job.name,
        CI_JOB_STAGE: job.stage,
        CI_COMMIT_SHA: p.sha,
        CI_COMMIT_SHORT_SHA: p.sha.slice(0, 8),
        CI_COMMIT_REF_NAME: p.ref,
        CI_PROJECT_PATH: `${workspace}/${project}`,
      },
    };
  }

  assigned(jobId: number, runnerId: number, token: string) {
    const now = new Date();
    this.setJob(jobId, { status: "running", runnerId, tokenHash: sha256(token), startedAt: now });
    const job = this.getJob(jobId)!;
    const p = this.get(job.pipelineId)!;
    this.db.update(pipelines).set({ status: "running", startedAt: p.startedAt ?? now }).where(eq(pipelines.id, p.id)).run();
    const runner = this.db.select({ name: runners.name }).from(runners).where(eq(runners.id, runnerId)).get();
    this.logs.append(jobId, `Running on runner ${runner?.name ?? runnerId}\n`);
  }

  requeue(jobId: number, reason: string) {
    this.setJob(jobId, { status: "pending", runnerId: null, tokenHash: null, startedAt: null });
    this.logs.append(jobId, `Back in the queue: ${reason}\n`);
  }

  log(jobId: number, text: string) {
    this.logs.append(jobId, text);
  }

  finished(jobId: number, result: CiResult) {
    const job = this.getJob(jobId);
    if (!job || job.status !== "running") return;
    const status = result.status === "succeeded" ? "success" : result.status;
    this.setJob(jobId, { status, error: result.error ?? null, tokenHash: null, finishedAt: new Date() });
    this.logs.append(jobId, `\nJob ${status === "success" ? "succeeded" : status}${result.error ? `: ${result.error}` : ""}\n`);
    this.advance(job.pipelineId);
    this.dispatcher?.dispatch();
  }

  // CI tokens can read (clone/fetch) the pipeline's repo while the job runs, nothing else.
  userForToken(token: string, projectId: number) {
    if (!token.startsWith(CI_TOKEN_PREFIX)) return null;
    const row = this.db
      .select({ id: users.id, username: users.username, kind: users.kind })
      .from(pipelineJobs)
      .innerJoin(pipelines, eq(pipelines.id, pipelineJobs.pipelineId))
      .innerJoin(users, eq(users.id, pipelines.triggeredById))
      .where(and(eq(pipelineJobs.tokenHash, sha256(token)), eq(pipelineJobs.status, "running"), eq(pipelines.projectId, projectId)))
      .get();
    return row ?? null;
  }

  // --- API shapes ---------------------------------------------------------------------------

  summary(p: PipelineRow): PipelineSummary {
    const { workspace, project } = this.projectPath(p.projectId);
    const user = this.db.select({ username: users.username }).from(users).where(eq(users.id, p.triggeredById)).get();
    const mr = p.mergeRequestId
      ? this.db.select({ number: mergeRequests.number }).from(mergeRequests).where(eq(mergeRequests.id, p.mergeRequestId)).get()
      : undefined;
    return {
      id: p.id,
      project: `${workspace}/${project}`,
      ref: p.ref,
      sha: p.sha,
      status: p.status,
      source: p.source,
      triggeredBy: user?.username ?? "",
      mergeRequest: mr?.number ?? null,
      error: p.error,
      createdAt: p.createdAt.toISOString(),
      startedAt: p.startedAt?.toISOString() ?? null,
      finishedAt: p.finishedAt?.toISOString() ?? null,
    };
  }

  jobToApi(j: CiJobRow): CiJob {
    const runner = j.runnerId ? this.db.select({ name: runners.name }).from(runners).where(eq(runners.id, j.runnerId)).get() : undefined;
    return {
      id: j.id,
      pipelineId: j.pipelineId,
      name: j.name,
      stage: j.stage,
      status: j.status,
      allowFailure: j.allowFailure,
      runner: runner?.name ?? null,
      error: j.error,
      waitingReason: j.status === "pending" ? (this.dispatcher?.ciWaitingReason() ?? null) : null,
      startedAt: j.startedAt?.toISOString() ?? null,
      finishedAt: j.finishedAt?.toISOString() ?? null,
    };
  }

  detail(p: PipelineRow): PipelineDetail {
    const all = this.jobsOf(p.id);
    return {
      ...this.summary(p),
      stages: [...new Map(all.map((j) => [j.stageIndex, j.stage])).entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s),
      jobs: all.map((j) => this.jobToApi(j)),
    };
  }

  list(projectId: number, limit = 50) {
    return this.db.select().from(pipelines).where(eq(pipelines.projectId, projectId)).orderBy(desc(pipelines.id)).limit(limit).all().map((p) => this.summary(p));
  }

  // Newest pipeline for a branch's commit.
  latestFor(projectId: number, ref: string, sha: string) {
    return this.db
      .select()
      .from(pipelines)
      .where(and(eq(pipelines.projectId, projectId), eq(pipelines.ref, ref), eq(pipelines.sha, sha)))
      .orderBy(desc(pipelines.id))
      .get();
  }

  // Pipelines still running jobs on `runnerId` (used when a runner reconnects).
  runningOn(runnerId: number) {
    return this.db.select().from(pipelineJobs).where(and(eq(pipelineJobs.runnerId, runnerId), inArray(pipelineJobs.status, ["running"]))).all();
  }
}
