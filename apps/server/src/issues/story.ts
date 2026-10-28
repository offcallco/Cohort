import { desc, eq } from "drizzle-orm";
import { issues, jobs as jobsTable, mergeRequests, pipelines as pipelinesTable, projects, users, type Db } from "@cohort/db";
import type { IssueDetail, Job, LoopStep, PipelineDetail, RunCard, TimelineEntry, WorkItemStory } from "@cohort/shared";
import { describeProgress } from "../mission.ts";
import { NO_SPLIT_LABEL } from "../jobs/issueFlow.ts";
import type { Jobs } from "../jobs/service.ts";
import { mergeRequestDetail } from "../mrs/service.ts";
import type { Pipelines } from "../pipelines/service.ts";
import { issueDetail } from "./service.ts";

type IssueRow = typeof issues.$inferSelect;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

// Where an issue is in the loop: spec → plan → code → test → review → merge.
export function loopSteps(input: {
  issue: Pick<IssueDetail, "origin" | "planStatus" | "labels" | "childIssues" | "body" | "author">;
  jobs: Pick<Job, "kind" | "status">[];
  mergeRequest: { status: "open" | "merged" | "closed"; files: number; targetBranch: string } | null;
  pipeline: Pick<PipelineDetail, "status" | "jobs"> | null;
  parts: { done: number; total: number } | null;
}): LoopStep[] {
  const { issue, jobs, mergeRequest: mr, pipeline, parts } = input;
  const active = (kind: Job["kind"]) => jobs.find((j) => j.kind === kind && (j.status === "queued" || j.status === "running"));
  const latest = (kinds: Job["kind"][]) => jobs.find((j) => kinds.includes(j.kind));

  const spec: LoopStep = {
    key: "spec",
    label: "Spec",
    state: "done",
    detail: issue.origin === "workshop" ? "From a workshop" : issue.origin === "split" ? "Split off by the agent" : `Written by ${issue.author.username}`,
  };

  let plan: LoopStep;
  const noPlan = issue.origin === "split" || issue.labels.some((l) => l.name === NO_SPLIT_LABEL);
  const planJob = latest(["split"]);
  if (noPlan && !planJob) plan = { key: "plan", label: "Plan", state: "skipped", detail: "Not needed" };
  else if (issue.planStatus === "pending") plan = { key: "plan", label: "Plan", state: "waiting", detail: "Waiting for your approval" };
  else if (active("split")) plan = { key: "plan", label: "Plan", state: "current", detail: issue.planStatus === "changes_requested" ? "Revising the plan" : "Planning" };
  else if (issue.planStatus === "rejected") plan = { key: "plan", label: "Plan", state: "failed", detail: "Rejected" };
  else if (planJob?.status === "failed") plan = { key: "plan", label: "Plan", state: "failed", detail: "Planning failed" };
  else if (issue.planStatus === "approved") plan = { key: "plan", label: "Plan", state: "done", detail: "Approved" };
  else if (issue.planStatus === "auto") plan = { key: "plan", label: "Plan", state: "done", detail: "Planned" };
  else plan = { key: "plan", label: "Plan", state: "pending", detail: "Not started" };

  let code: LoopStep;
  const coding = active("implement") ?? active("resolve");
  const lastCode = latest(["implement", "resolve"]);
  if (parts && parts.total > 0) {
    code =
      parts.done === parts.total
        ? { key: "code", label: "Code", state: "done", detail: `${parts.total} parts merged` }
        : { key: "code", label: "Code", state: "current", detail: `${parts.done} of ${parts.total} parts merged` };
  } else if (coding) code = { key: "code", label: "Code", state: "current", detail: coding.kind === "resolve" ? "Resolving a conflict" : "Writing code" };
  else if (lastCode?.status === "failed" && mr?.status !== "merged") code = { key: "code", label: "Code", state: "failed", detail: "The last run failed" };
  else if (mr) code = { key: "code", label: "Code", state: "done", detail: `${plural(mr.files, "file")} changed` };
  else code = { key: "code", label: "Code", state: "pending", detail: "Not started" };

  let test: LoopStep;
  const passed = pipeline?.jobs.filter((j) => j.status === "success").length ?? 0;
  const failed = pipeline?.jobs.filter((j) => j.status === "failed" && !j.allowFailure).length ?? 0;
  if (!mr) test = { key: "test", label: "Test", state: "pending", detail: "After the code" };
  else if (!pipeline) test = { key: "test", label: "Test", state: "skipped", detail: "No pipeline" };
  else if (pipeline.status === "manual") test = { key: "test", label: "Test", state: "waiting", detail: "Waiting for you to start it" };
  else if (pipeline.status === "pending" || pipeline.status === "running") test = { key: "test", label: "Test", state: "current", detail: `${passed} of ${pipeline.jobs.length} checks passed so far` };
  else if (pipeline.status === "success") test = { key: "test", label: "Test", state: "done", detail: `${plural(passed, "check")} passed` };
  else if (pipeline.status === "failed") test = { key: "test", label: "Test", state: "failed", detail: `${plural(failed, "check")} failed` };
  else test = { key: "test", label: "Test", state: "pending", detail: "Canceled" };

  let review: LoopStep;
  let merge: LoopStep;
  if (!mr) {
    review = { key: "review", label: "Review", state: "pending", detail: "After the code" };
    merge = { key: "merge", label: "Merge", state: "pending", detail: "After review" };
  } else if (mr.status === "merged") {
    review = { key: "review", label: "Review", state: "done", detail: "Approved" };
    merge = { key: "merge", label: "Merge", state: "done", detail: `Merged into ${mr.targetBranch}` };
  } else if (mr.status === "closed") {
    review = { key: "review", label: "Review", state: "failed", detail: "Closed without merging" };
    merge = { key: "merge", label: "Merge", state: "skipped", detail: "Not merged" };
  } else {
    review = coding
      ? { key: "review", label: "Review", state: "pending", detail: "The agent is updating it" }
      : { key: "review", label: "Review", state: "waiting", detail: "Waiting for your review" };
    merge = { key: "merge", label: "Merge", state: "pending", detail: `Into ${mr.targetBranch}` };
  }
  return [spec, plan, code, test, review, merge];
}

export class StoryService {
  constructor(
    private readonly db: Db,
    private readonly reposRoot: string,
    private readonly jobs: Jobs,
    private readonly pipelines: Pipelines,
  ) {}

  async story(row: IssueRow): Promise<WorkItemStory> {
    const issue = issueDetail(this.db, row);
    const jobList = this.jobs.list({ issueId: row.id }, 100);
    const project = this.db.select().from(projects).where(eq(projects.id, row.projectId)).get()!;
    const base = `/${issue.project}`;

    const mrRow = this.db.select().from(mergeRequests).where(eq(mergeRequests.issueId, row.id)).orderBy(desc(mergeRequests.id)).get();
    let mergeRequest: WorkItemStory["mergeRequest"] = null;
    let pipeline: PipelineDetail | null = null;
    if (mrRow) {
      const detail = await mergeRequestDetail(this.db, this.reposRoot, mrRow);
      const { description: _d, comments: _c, commits, files, ...summary } = detail;
      mergeRequest = {
        ...summary,
        commits: commits.length,
        files: files.map((f) => ({ path: f.newPath ?? f.oldPath ?? "", status: f.status, additions: f.additions, deletions: f.deletions })),
        pipelinesMustSucceed: project.pipelinesMustSucceed,
      };
      const p = this.db.select().from(pipelinesTable).where(eq(pipelinesTable.mergeRequestId, mrRow.id)).orderBy(desc(pipelinesTable.id)).get();
      pipeline = p ? this.pipelines.detail(p) : null;
    }

    const kids = this.db.select().from(issues).where(eq(issues.parentId, row.id)).all().filter((k) => k.origin === "split");
    const parts = kids.length ? { done: kids.filter((k) => k.status === "done").length, total: kids.length } : null;
    const steps = loopSteps({
      issue,
      jobs: jobList,
      mergeRequest: mergeRequest ? { status: mergeRequest.status, files: mergeRequest.files.length, targetBranch: mergeRequest.targetBranch } : null,
      pipeline,
      parts,
    });
    const summary = jobList.find((j) => j.kind === "implement" && j.status === "succeeded" && j.summary)?.summary ?? null;

    const live = jobList.find((j) => j.status === "queued" || j.status === "running");
    const run: RunCard | null = live
      ? {
          jobId: live.id,
          agent: live.bot,
          kind: live.kind,
          status: live.status as "queued" | "running",
          project: issue.project,
          task: issue.title,
          taskHref: `${base}/issues/${issue.number}`,
          ...describeProgress(live, this.jobs.logs.tail(live.id), live.waitingReason),
          startedAt: live.startedAt,
        }
      : null;

    // Chronological story: who did what, linked to evidence.
    const people = new Map(this.db.select({ id: users.id, username: users.username, kind: users.kind }).from(users).all().map((u) => [u.id, u]));
    const timeline: TimelineEntry[] = [
      { at: issue.createdAt, actor: issue.author.username, bot: issue.author.kind === "bot", text: "Opened the issue", href: null },
      ...issue.commentList.map((c) => ({
        at: c.createdAt,
        actor: c.author.username,
        bot: c.author.kind === "bot",
        text: c.body.length > 280 ? `${c.body.slice(0, 280)}…` : c.body,
        href: null,
      })),
    ];
    for (const j of jobList) {
      const what = { implement: "coding", split: "planning", resolve: "conflict resolution", workshop: "workshop turn" }[j.kind];
      if (j.startedAt) timeline.push({ at: j.startedAt, actor: j.bot, bot: true, text: `Started ${what}`, href: `${base}/jobs/${j.id}` });
      if (j.finishedAt && j.status !== "succeeded") {
        timeline.push({ at: j.finishedAt, actor: j.bot, bot: true, text: j.status === "failed" ? `${what[0]!.toUpperCase()}${what.slice(1)} failed: ${j.error}` : `Stopped ${what}`, href: `${base}/jobs/${j.id}` });
      }
    }
    if (pipeline?.finishedAt) {
      timeline.push({ at: pipeline.finishedAt, actor: "CI", bot: true, text: `Pipeline #${pipeline.id} ${pipeline.status === "success" ? "passed" : pipeline.status}`, href: `${base}/pipelines/${pipeline.id}` });
    }
    if (mrRow) {
      const author = people.get(mrRow.authorId);
      timeline.push({ at: mrRow.createdAt.toISOString(), actor: author?.username ?? "", bot: author?.kind === "bot", text: `Opened !${mrRow.number}`, href: `${base}/merge_requests/${mrRow.number}` });
    }
    if (mrRow?.mergedAt) {
      const merger = mrRow.mergedById ? people.get(mrRow.mergedById) : undefined;
      timeline.push({ at: mrRow.mergedAt.toISOString(), actor: merger?.username ?? "", bot: merger?.kind === "bot", text: `Merged !${mrRow.number}`, href: `${base}/merge_requests/${mrRow.number}` });
    }
    timeline.sort((a, b) => a.at.localeCompare(b.at));

    return { issue, steps, jobs: jobList, mergeRequest, pipeline, summary, run, timeline };
  }
}
