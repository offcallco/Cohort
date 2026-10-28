import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import {
  issues,
  jobs,
  mergeRequests,
  pipelineJobs,
  pipelines,
  projects,
  users,
  workshopMessages,
  workshops,
  workspaces,
  type Db,
} from "@cohort/db";
import type { Evidence, MissionControl, NeedsYouItem, Outcome, RunCard, RunStep, RunSummary } from "@cohort/shared";
import { branchSha, defaultBranch, diffBetween, repoDir } from "./git/repo.ts";
import type { Jobs } from "./jobs/service.ts";

type JobRow = typeof jobs.$inferSelect;

const DAY = 24 * 3600_000;

// Turns the end of an agent's log into what it's doing now, in plain English, plus the files
// it has edited. Runner log lines look like "→ Edit /…/worktrees/job-3/src/app.ts".
export function describeProgress(job: Pick<JobRow, "kind" | "status">, log: string, waitingReason: string | null) {
  const clean = (path: string) => path.replace(/^.*\/(worktrees\/job-\d+|workshops\/w-\d+|ci\/job-\d+)\//, "");
  const edited = new Set<string>();
  let phase: string | null = null;
  for (const line of log.split("\n")) {
    const tool = line.match(/^→ (\w+)(?: (.*))?$/);
    if (tool) {
      const [, name, arg = ""] = tool;
      if (name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit") {
        edited.add(clean(arg));
        phase = `Editing ${clean(arg)}`;
      } else if (name === "Read") phase = `Reading ${clean(arg)}`;
      else if (name === "Bash") phase = `Running \`${arg.slice(0, 60)}\``;
      else if (name === "Grep" || name === "Glob") phase = "Searching the code";
      else phase = `Using ${name}`;
      continue;
    }
    if (line.startsWith("$ ")) phase = `Running \`${line.slice(2, 62)}\``;
    else if (line.startsWith("Fetching ") || line.startsWith("Checking out")) phase = "Checking out the code";
    else if (line.startsWith("Pushing ")) phase = "Pushing the changes";
    else if (line.startsWith("Conflicts in ")) phase = `Resolving conflicts in ${line.slice(13)}`;
  }
  if (job.status === "queued") return { phase: waitingReason ?? "Waiting for a runner", filesTouched: 0 };
  const fallback = {
    implement: "Starting on the task",
    split: "Reading the code to plan the work",
    resolve: "Resolving a merge conflict",
    workshop: "Reading the code to answer you",
  }[job.kind];
  return { phase: phase ?? fallback, filesTouched: edited.size };
}

// A run's steps, read from its log: checked out, read, searched, edited, ran commands, pushed.
export function describeSteps(job: Pick<JobRow, "kind" | "status">, log: string): RunStep[] {
  const clean = (path: string) => path.replace(/^.*\/(worktrees\/job-\d+|workshops\/w-\d+|ci\/job-\d+)\//, "");
  const read = new Set<string>();
  const edited = new Set<string>();
  const commands: string[] = [];
  let searches = 0;
  let checkedOut = false;
  let pushed: string | null = null;
  let conflicts: string | null = null;
  for (const line of log.split("\n")) {
    const tool = line.match(/^→ (\w+)(?: (.*))?$/);
    if (tool) {
      const [, name, arg = ""] = tool;
      if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(name!)) edited.add(clean(arg));
      else if (name === "Read") read.add(clean(arg));
      else if (name === "Grep" || name === "Glob") searches++;
      else if (name === "Bash") commands.push(arg);
    } else if (line.startsWith("$ ")) commands.push(line.slice(2));
    else if (line.startsWith("Checked out") || line.startsWith("Checking out")) checkedOut = true;
    else if (line.startsWith("Pushing ")) pushed = line.replace(/^Pushing /, "");
    else if (line.startsWith("Conflicts in ")) conflicts = line.slice(13);
  }
  const list = (items: Iterable<string>, max = 3) => {
    const all = [...items];
    return all.length > max ? `${all.slice(0, max).join(", ")} and ${all.length - max} more` : all.join(", ");
  };
  const steps: RunStep[] = [];
  if (checkedOut) steps.push({ label: "Checked out the code", detail: null, state: "done" });
  if (conflicts) steps.push({ label: "Found merge conflicts", detail: conflicts, state: "done" });
  if (read.size) steps.push({ label: `Read ${read.size} file${read.size === 1 ? "" : "s"}`, detail: list(read), state: "done" });
  if (searches) steps.push({ label: `Searched the code ${searches} time${searches === 1 ? "" : "s"}`, detail: null, state: "done" });
  if (edited.size) steps.push({ label: `Edited ${edited.size} file${edited.size === 1 ? "" : "s"}`, detail: list(edited), state: "done" });
  if (commands.length) steps.push({ label: `Ran ${commands.length} command${commands.length === 1 ? "" : "s"}`, detail: list(commands.map((c) => c.slice(0, 60)), 2), state: "done" });
  if (pushed) steps.push({ label: "Pushed the changes", detail: pushed, state: "done" });
  const last = steps.at(-1);
  if (last && (job.status === "running" || job.status === "queued")) last.state = "current";
  if (job.status === "failed") steps.push({ label: "Failed", detail: null, state: "failed" });
  return steps;
}

export class MissionService {
  constructor(
    private readonly db: Db,
    private readonly reposRoot: string,
    private readonly jobs: Jobs,
  ) {}

  private projectPaths() {
    return new Map(
      this.db
        .select({ id: projects.id, workspace: workspaces.slug, project: projects.slug })
        .from(projects)
        .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
        .all()
        .map((p) => [p.id, { path: `${p.workspace}/${p.project}`, gitDir: repoDir(this.reposRoot, p.workspace, p.project) }]),
    );
  }

  private botNames() {
    return new Map(this.db.select({ id: users.id, username: users.username, kind: users.kind }).from(users).all().map((u) => [u.id, u]));
  }

  // Everything waiting on a person, longest-waiting first.
  async needsYou(): Promise<NeedsYouItem[]> {
    const paths = this.projectPaths();
    const people = this.botNames();
    const items: NeedsYouItem[] = [];
    const agentName = (id: number | null) => {
      const u = id !== null ? people.get(id) : undefined;
      return u?.kind === "bot" ? u.username : null;
    };

    // Merge requests: start their pipeline if it's waiting, otherwise review them.
    for (const mr of this.db.select().from(mergeRequests).where(eq(mergeRequests.status, "open")).all()) {
      const p = paths.get(mr.projectId)!;
      const href = `/${p.path}/merge_requests/${mr.number}`;
      const sha = await branchSha(p.gitDir, mr.sourceBranch);
      const pipeline = sha
        ? this.db
            .select()
            .from(pipelines)
            .where(and(eq(pipelines.projectId, mr.projectId), eq(pipelines.ref, mr.sourceBranch), eq(pipelines.sha, sha)))
            .orderBy(desc(pipelines.id))
            .get()
        : undefined;
      if (pipeline?.status === "manual") {
        items.push({
          id: `pipeline-${pipeline.id}`,
          kind: "pipeline",
          title: mr.title,
          project: p.path,
          agent: agentName(mr.authorId),
          need: `Start the pipeline for !${mr.number}. It runs the agent's changes on your runner.`,
          since: pipeline.createdAt.toISOString(),
          href,
          action: { label: "Run pipeline", method: "post", url: `/api/projects/${p.path}/pipelines/${pipeline.id}/run` },
        });
        continue;
      }
      const checks =
        pipeline?.status === "failed" ? "Its pipeline failed." : pipeline?.status === "success" ? "Its pipeline passed." : pipeline ? "Its pipeline is still running." : "";
      items.push({
        id: `mr-${mr.id}`,
        kind: "review",
        title: mr.title,
        project: p.path,
        agent: agentName(mr.authorId),
        need: `Review !${mr.number} and merge it. ${checks}`.trim(),
        since: mr.createdAt.toISOString(),
        href,
        action: { label: "Review", method: "link" },
      });
    }

    // Splits waiting for approval, and failed agent jobs on blocked issues.
    const waiting = this.db.select().from(issues).all().filter((i) => i.planStatus === "pending" || i.splitProposal || i.status === "blocked");
    for (const issue of waiting) {
      const p = paths.get(issue.projectId)!;
      const href = `/${p.path}/issues/${issue.number}`;
      if (issue.planStatus === "pending") {
        const split = issue.splitProposal ? (JSON.parse(issue.splitProposal) as { issues: unknown[] }).issues.length : 0;
        items.push({
          id: `plan-${issue.id}`,
          kind: "plan",
          title: issue.title,
          project: p.path,
          agent: agentName(issue.assigneeId),
          need: `Approve the plan before the agent writes code${split ? `. It splits the work into ${split} sub-issues.` : "."}`,
          since: issue.updatedAt.toISOString(),
          href,
          action: { label: "Review plan", method: "link" },
        });
        continue;
      }
      if (issue.splitProposal) {
        const proposal = JSON.parse(issue.splitProposal) as { issues: unknown[] };
        items.push({
          id: `split-${issue.id}`,
          kind: "split",
          title: issue.title,
          project: p.path,
          agent: agentName(issue.assigneeId),
          need: `Approve splitting it into ${proposal.issues.length} sub-issues.`,
          since: issue.updatedAt.toISOString(),
          href,
          action: { label: "Decide", method: "link" },
        });
        continue;
      }
      const job = this.db.select().from(jobs).where(eq(jobs.issueId, issue.id)).orderBy(desc(jobs.id)).get();
      if (job?.status !== "failed") continue;
      items.push({
        id: `job-${job.id}`,
        kind: "failed_job",
        title: issue.title,
        project: p.path,
        agent: agentName(job.botId),
        need: `Failed: ${job.error ?? "the agent stopped"}.`,
        since: (job.finishedAt ?? job.createdAt).toISOString(),
        href,
        action: { label: "Retry", method: "post", url: `/api/jobs/${job.id}/retry` },
      });
    }

    // Workshops where the agent is waiting for your answer or your call on its proposal.
    for (const w of this.db.select().from(workshops).where(eq(workshops.status, "active")).all()) {
      const active = this.db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.workshopId, w.id), inArray(jobs.status, ["queued", "running"]))).get();
      if (active) continue;
      const last = this.db.select().from(workshopMessages).where(eq(workshopMessages.workshopId, w.id)).orderBy(desc(workshopMessages.id)).get();
      if (last?.role !== "agent") continue;
      const p = paths.get(w.projectId)!;
      const question = last.body
        .split("\n")
        .find((l) => l.includes("?"))
        ?.replace(/[*_#>]/g, "")
        .replace(/^\s*question:\s*/i, "")
        .trim();
      items.push({
        id: `workshop-${w.id}`,
        kind: "workshop",
        title: w.title,
        project: p.path,
        agent: agentName(w.botId),
        need: w.proposal ? "Review the proposed issues and create them." : `Answer: ${question?.slice(0, 140) ?? "the agent asked you a question"}`,
        since: last.createdAt.toISOString(),
        href: `/${p.path}/workshops/${w.id}`,
        action: { label: w.proposal ? "Review issues" : "Answer", method: "link" },
      });
    }

    // The default branch's latest pipeline failed.
    for (const [projectId, p] of paths) {
      const main = await defaultBranch(p.gitDir);
      if (!main) continue;
      const latest = this.db.select().from(pipelines).where(and(eq(pipelines.projectId, projectId), eq(pipelines.ref, main))).orderBy(desc(pipelines.id)).get();
      if (latest?.status !== "failed") continue;
      const failed = this.db.select({ name: pipelineJobs.name }).from(pipelineJobs).where(and(eq(pipelineJobs.pipelineId, latest.id), eq(pipelineJobs.status, "failed"))).all();
      items.push({
        id: `main-${latest.id}`,
        kind: "failed_pipeline",
        title: `Pipeline #${latest.id} on ${main}`,
        project: p.path,
        agent: null,
        need: latest.error ?? `Failed: ${failed.map((f) => f.name).join(", ") || "a job"} on ${main}.`,
        since: (latest.finishedAt ?? latest.createdAt).toISOString(),
        href: `/${p.path}/pipelines/${latest.id}`,
        action: { label: "View", method: "link" },
      });
    }

    return items.sort((a, b) => a.since.localeCompare(b.since));
  }

  running(): RunCard[] {
    const paths = this.projectPaths();
    const people = this.botNames();
    const rows = this.db.select().from(jobs).where(inArray(jobs.status, ["queued", "running"])).orderBy(asc(jobs.id)).all();
    return rows.map((job) => {
      const p = paths.get(job.projectId)!;
      const issue = job.issueId ? this.db.select().from(issues).where(eq(issues.id, job.issueId)).get() : undefined;
      const workshop = job.workshopId ? this.db.select().from(workshops).where(eq(workshops.id, job.workshopId)).get() : undefined;
      const api = this.jobs.toApi(job);
      const { phase, filesTouched } = describeProgress(job, this.jobs.logs.tail(job.id), api.waitingReason);
      return {
        jobId: job.id,
        agent: people.get(job.botId)?.username ?? "",
        kind: job.kind,
        status: job.status as "queued" | "running",
        project: p.path,
        task: issue?.title ?? workshop?.title ?? `Job #${job.id}`,
        taskHref: issue ? `/${p.path}/issues/${issue.number}` : workshop ? `/${p.path}/workshops/${workshop.id}` : `/${p.path}/jobs/${job.id}`,
        phase,
        startedAt: job.startedAt?.toISOString() ?? null,
        filesTouched,
      };
    });
  }

  // The last `limit` merged, failed or stopped items, newest first.
  async recent(limit = 10): Promise<Outcome[]> {
    const paths = this.projectPaths();
    const people = this.botNames();
    const agentName = (id: number | null) => (id !== null && people.get(id)?.kind === "bot" ? people.get(id)!.username : null);

    const merged = this.db.select().from(mergeRequests).where(eq(mergeRequests.status, "merged")).orderBy(desc(mergeRequests.mergedAt)).limit(limit).all();
    const ended = this.db
      .select()
      .from(jobs)
      .where(and(inArray(jobs.status, ["failed", "canceled"]), inArray(jobs.kind, ["implement", "split", "resolve"])))
      .orderBy(desc(jobs.finishedAt))
      .limit(limit)
      .all();

    const outcomes: Outcome[] = [];
    for (const mr of merged) {
      const p = paths.get(mr.projectId)!;
      let evidence: Evidence | null = null;
      if (mr.mergeSha) {
        const files = await diffBetween(p.gitDir, `${mr.mergeSha}^1`, `${mr.mergeSha}^2`).catch(() => []);
        const checks = this.checksFor(mr.id);
        evidence = {
          files: files.length,
          additions: files.reduce((n, f) => n + f.additions, 0),
          deletions: files.reduce((n, f) => n + f.deletions, 0),
          ...checks,
        };
      }
      const cost = this.db.select({ costUsd: jobs.costUsd }).from(jobs).where(eq(jobs.mergeRequestId, mr.id)).all();
      const total = cost.reduce((n, c) => n + (c.costUsd ?? 0), 0);
      outcomes.push({
        id: `mr-${mr.id}`,
        kind: "merged",
        title: mr.title,
        project: p.path,
        agent: agentName(mr.authorId),
        at: (mr.mergedAt ?? mr.updatedAt).toISOString(),
        href: `/${p.path}/merge_requests/${mr.number}`,
        detail: null,
        evidence,
        costUsd: cost.some((c) => c.costUsd !== null) ? total : null,
      });
    }
    for (const job of ended) {
      const p = paths.get(job.projectId)!;
      const issue = job.issueId ? this.db.select().from(issues).where(eq(issues.id, job.issueId)).get() : undefined;
      outcomes.push({
        id: `job-${job.id}`,
        kind: job.status === "failed" ? "failed" : "canceled",
        title: issue?.title ?? `Job #${job.id}`,
        project: p.path,
        agent: agentName(job.botId),
        at: (job.finishedAt ?? job.createdAt).toISOString(),
        href: issue ? `/${p.path}/issues/${issue.number}` : `/${p.path}/jobs/${job.id}`,
        detail: job.status === "failed" ? job.error : "Stopped",
        evidence: null,
        costUsd: job.costUsd,
      });
    }
    return outcomes.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
  }

  // Pass/fail counts from a merge request's latest pipeline.
  private checksFor(mergeRequestId: number) {
    const latest = this.db.select().from(pipelines).where(eq(pipelines.mergeRequestId, mergeRequestId)).orderBy(desc(pipelines.id)).get();
    if (!latest) return { checksPassed: 0, checksFailed: 0 };
    const all = this.db.select({ status: pipelineJobs.status }).from(pipelineJobs).where(eq(pipelineJobs.pipelineId, latest.id)).all();
    return {
      checksPassed: all.filter((j) => j.status === "success").length,
      checksFailed: all.filter((j) => j.status === "failed").length,
    };
  }

  // Everything the run page shows.
  runSummary(job: JobRow): RunSummary {
    const api = this.jobs.toApi(job);
    const log = this.jobs.logs.tail(job.id, 256 * 1024);
    const { phase, filesTouched } = describeProgress(job, log, api.waitingReason);
    const issue = job.issueId ? this.db.select().from(issues).where(eq(issues.id, job.issueId)).get() : undefined;
    const mr = job.mergeRequestId
      ? this.db.select().from(mergeRequests).where(eq(mergeRequests.id, job.mergeRequestId)).get()
      : undefined;
    const pipeline = mr ? this.db.select().from(pipelines).where(eq(pipelines.mergeRequestId, mr.id)).orderBy(desc(pipelines.id)).get() : undefined;
    const ended = job.status === "succeeded" ? "Finished" : job.status === "failed" ? `Failed: ${job.error ?? "the agent stopped"}` : job.status === "canceled" ? "Stopped" : null;
    return {
      job: api,
      phase: ended ?? (job.pausedAt ? `Paused. ${phase}` : phase),
      filesTouched,
      steps: describeSteps(job, log),
      artifacts: {
        plan: issue?.plan ?? null,
        mergeRequest: mr ? { number: mr.number, title: mr.title, files: filesTouched, status: mr.status } : null,
        pipeline: pipeline ? { ...this.pipelineSummary(pipeline) } : null,
        summary: job.summary,
      },
    };
  }

  private pipelineSummary(p: typeof pipelines.$inferSelect) {
    const project = this.projectPaths().get(p.projectId)!;
    const by = this.db.select({ username: users.username }).from(users).where(eq(users.id, p.triggeredById)).get();
    const mr = p.mergeRequestId ? this.db.select({ number: mergeRequests.number }).from(mergeRequests).where(eq(mergeRequests.id, p.mergeRequestId)).get() : undefined;
    return {
      id: p.id,
      project: project.path,
      ref: p.ref,
      sha: p.sha,
      status: p.status,
      source: p.source,
      triggeredBy: by?.username ?? "",
      mergeRequest: mr?.number ?? null,
      error: p.error,
      createdAt: p.createdAt.toISOString(),
      startedAt: p.startedAt?.toISOString() ?? null,
      finishedAt: p.finishedAt?.toISOString() ?? null,
    };
  }

  async summary(): Promise<MissionControl> {
    const needs = await this.needsYou();
    const running = this.running();
    const since = new Date(Date.now() - DAY);
    const failedJobs = this.db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.status, "failed"), gt(jobs.finishedAt, since))).all().length;
    const failedPipelines = this.db
      .select({ id: pipelines.id })
      .from(pipelines)
      .where(and(eq(pipelines.status, "failed"), gt(pipelines.createdAt, since)))
      .all().length;
    return {
      counts: { running: running.filter((r) => r.status === "running").length, needsYou: needs.length, failed24h: failedJobs + failedPipelines },
      needsYou: needs.slice(0, 5),
      running,
      recent: await this.recent(),
    };
  }
}
