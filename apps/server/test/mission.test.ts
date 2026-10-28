import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issues, jobs, pipelineJobs, pipelines, users, workshopMessages, workshops } from "@cohort/db";
import type { MissionControl, NeedsYouItem } from "@cohort/shared";
import { createBranch, repoDir } from "../src/git/repo.ts";
import { describeProgress } from "../src/mission.ts";
import { createTestApp, signUp, type App } from "./helpers.ts";

let app: App;
let db: Awaited<ReturnType<typeof createTestApp>>["db"];
let reposRoot: string;
let cleanup: () => Promise<void>;
let cookie: string;

const call = async (method: "GET" | "POST" | "PATCH", url: string, payload?: object) => {
  const res = await app.inject({ method, url, payload, headers: { cookie } });
  return { status: res.statusCode, body: res.json() };
};

beforeAll(async () => {
  ({ app, db, reposRoot, cleanup } = await createTestApp({ graceMs: 3600_000 }));
  ({ cookie } = await signUp(app));
  await call("POST", "/api/workspaces", { name: "Acme", slug: "acme" });
  await call("POST", "/api/workspaces/acme/projects", { name: "API", slug: "api", initReadme: true });
});

afterAll(() => cleanup());

const bot = () => db.select().from(users).all().find((u) => u.username === "claude-bot")!;

describe("describeProgress", () => {
  const running = { kind: "implement" as const, status: "running" as const };

  it("reads the latest step and the files edited", () => {
    const log = [
      "Claude Code started",
      "→ Read /data/runner/worktrees/job-3/src/app.ts",
      "→ Edit /data/runner/worktrees/job-3/src/app.ts",
      "→ Write /data/runner/worktrees/job-3/src/app.test.ts",
      "→ Edit /data/runner/worktrees/job-3/src/app.ts",
      "→ Grep login",
    ].join("\n");
    expect(describeProgress(running, log, null)).toEqual({ phase: "Searching the code", filesTouched: 2 });
    expect(describeProgress(running, log.split("\n").slice(0, 4).join("\n"), null).phase).toBe("Editing src/app.test.ts");
  });

  it("describes commands, checkout, pushes and empty logs", () => {
    expect(describeProgress(running, "→ Bash npm test", null).phase).toBe("Running `npm test`");
    expect(describeProgress(running, "Fetching acme/api", null).phase).toBe("Checking out the code");
    expect(describeProgress(running, "Pushing 2 commits to x", null).phase).toBe("Pushing the changes");
    expect(describeProgress({ kind: "split", status: "running" }, "", null).phase).toBe("Reading the code to plan the work");
    expect(describeProgress({ kind: "implement", status: "queued" }, "", "No runner with codex is online").phase).toBe("No runner with codex is online");
  });
});

describe("mission control", () => {
  it("is calm when nothing is happening", async () => {
    const res = await call("GET", "/api/mission");
    expect(res.body).toEqual({ counts: { running: 0, needsYou: 0, failed24h: 0 }, needsYou: [], running: [], recent: [] });
  });

  it("collects what needs you, what's running and what finished", async () => {
    const b = bot();
    const gitDir = repoDir(reposRoot, "acme", "api");
    const api = "/api/projects/acme/api";

    // A running agent job with some progress in its log.
    const running = (await call("POST", `${api}/issues`, { title: "Rate limiting" })).body.issue;
    const job = db
      .insert(jobs)
      .values({ projectId: 1, issueId: running.id, kind: "implement", botId: b.id, agentType: "claude-code", branch: "cohort/1-rate", baseBranch: "main", status: "running", startedAt: new Date() })
      .returning()
      .get();
    app.jobs.logs.append(job.id, "→ Edit /x/worktrees/job-1/src/limit.ts\n");

    // An agent MR whose pipeline waits for a person.
    await createBranch(gitDir, "cohort/2-checkout", "main");
    const mr = (await call("POST", `${api}/merge_requests`, { title: "Checkout", sourceBranch: "cohort/2-checkout", targetBranch: "main" })).body.mergeRequest;
    const head = (await call("GET", api)).body.branches.find((x: { name: string }) => x.name === "cohort/2-checkout").sha;
    const p = db.insert(pipelines).values({ projectId: 1, ref: "cohort/2-checkout", sha: head, status: "manual", source: "merge_request", triggeredById: b.id, mergeRequestId: mr.id }).returning().get();
    db.insert(pipelineJobs).values({ pipelineId: p.id, name: "test", stage: "test", stageIndex: 1, script: "[]" }).run();

    // A blocked issue whose agent job failed.
    const blocked = (await call("POST", `${api}/issues`, { title: "Flaky test" })).body.issue;
    db.update(issues).set({ status: "blocked" }).where(eq(issues.id, blocked.id)).run();
    const failed = db
      .insert(jobs)
      .values({ projectId: 1, issueId: blocked.id, kind: "implement", botId: b.id, agentType: "claude-code", branch: "cohort/3-flaky", baseBranch: "main", status: "failed", error: "Tests timed out", finishedAt: new Date(), costUsd: 0.12 })
      .returning()
      .get();

    // A workshop waiting for an answer.
    const w = db.insert(workshops).values({ projectId: 1, title: "Payouts", botId: b.id, baseBranch: "main", createdById: 1 }).returning().get();
    db.insert(workshopMessages).values([
      { workshopId: w.id, role: "user", body: "Payout schedules" },
      { workshopId: w.id, role: "agent", body: "Good idea.\n\n**Which schedules do you need?** I recommend daily and weekly." },
    ]).run();

    const mission = (await call("GET", "/api/mission")).body as MissionControl;
    expect(mission.counts).toEqual({ running: 1, needsYou: 3, failed24h: 1 });
    expect(mission.running).toEqual([
      expect.objectContaining({ jobId: job.id, agent: "claude-bot", task: "Rate limiting", phase: "Editing src/limit.ts", filesTouched: 1, taskHref: "/acme/api/issues/1" }),
    ]);

    const byKind = Object.fromEntries(mission.needsYou.map((i: NeedsYouItem) => [i.kind, i]));
    expect(byKind.pipeline).toMatchObject({
      title: "Checkout",
      href: "/acme/api/merge_requests/1",
      action: { label: "Run pipeline", method: "post", url: `/api/projects/acme/api/pipelines/${p.id}/run` },
    });
    expect(byKind.failed_job).toMatchObject({ need: "Failed: Tests timed out.", agent: "claude-bot", action: { label: "Retry", url: `/api/jobs/${failed.id}/retry` } });
    expect(byKind.workshop).toMatchObject({ need: "Answer: Which schedules do you need? I recommend daily and weekly.", href: `/acme/api/workshops/${w.id}` });
    expect(mission.recent).toEqual([expect.objectContaining({ kind: "failed", title: "Flaky test", detail: "Tests timed out", costUsd: 0.12 })]);

    // Starting the pipeline turns the item into a review.
    await call("POST", `/api/projects/acme/api/pipelines/${p.id}/run`);
    const reviews = (await call("GET", "/api/reviews")).body.items as NeedsYouItem[];
    expect(reviews.find((i) => i.kind === "review")).toMatchObject({ need: "Review !1 and merge it. Its pipeline is still running.", action: { label: "Review" } });

    // Merging moves it to recent outcomes with evidence.
    await call("POST", `/api/projects/acme/api/pipelines/${p.id}/cancel`);
    await call("POST", `${api}/merge_requests/1/merge`, {});
    const after = (await call("GET", "/api/mission")).body as MissionControl;
    expect(after.needsYou.some((i) => i.kind === "review" || i.kind === "pipeline")).toBe(false);
    expect(after.recent[0]).toMatchObject({ kind: "merged", title: "Checkout", evidence: { files: 0, checksPassed: 0, checksFailed: 0 } });
  });

  it("shows splits waiting for approval and failed pipelines on the default branch", async () => {
    const b = bot();
    const split = (await call("POST", "/api/projects/acme/api/issues", { title: "Big one" })).body.issue;
    db.update(issues)
      .set({ splitProposal: JSON.stringify({ issues: [{ key: "a" }, { key: "b" }, { key: "c" }], limit: 2 }), assigneeId: b.id })
      .where(eq(issues.id, split.id))
      .run();
    const main = db.insert(pipelines).values({ projectId: 1, ref: "main", sha: "abc", status: "failed", source: "push", triggeredById: 1, finishedAt: new Date() }).returning().get();
    db.insert(pipelineJobs).values({ pipelineId: main.id, name: "lint", stage: "test", stageIndex: 1, script: "[]", status: "failed" }).run();

    const items = (await call("GET", "/api/reviews")).body.items as NeedsYouItem[];
    expect(items.find((i) => i.kind === "split")).toMatchObject({ need: "Approve splitting it into 3 sub-issues.", agent: "claude-bot" });
    expect(items.find((i) => i.kind === "failed_pipeline")).toMatchObject({ need: "Failed: lint on main.", href: `/acme/api/pipelines/${main.id}` });
  });
});

