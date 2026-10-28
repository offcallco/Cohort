import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LoopStep, WorkItemStory } from "@cohort/shared";
import { loopSteps } from "../src/issues/story.ts";
import { createTestApp, signUp, type App } from "./helpers.ts";

type Input = Parameters<typeof loopSteps>[0];
const base: Input = {
  issue: { origin: "user", planStatus: null, labels: [], childIssues: [], body: "", author: { id: 1, username: "justin", kind: "human" } },
  jobs: [],
  mergeRequest: null,
  pipeline: null,
  parts: null,
};
const states = (input: Partial<Input>) =>
  Object.fromEntries(loopSteps({ ...base, ...input }).map((s: LoopStep) => [s.key, `${s.state}: ${s.detail}`]));

describe("loopSteps", () => {
  it("starts with only the spec done", () => {
    expect(states({})).toEqual({
      spec: "done: Written by justin",
      plan: "pending: Not started",
      code: "pending: Not started",
      test: "pending: After the code",
      review: "pending: After the code",
      merge: "pending: After review",
    });
  });

  it("shows planning, then waiting for approval", () => {
    expect(states({ jobs: [{ kind: "split", status: "running" }] }).plan).toBe("current: Planning");
    expect(states({ issue: { ...base.issue, planStatus: "pending" }, jobs: [{ kind: "split", status: "succeeded" }] }).plan).toBe(
      "waiting: Waiting for your approval",
    );
  });

  it("tracks coding, parts and the pipeline", () => {
    const approved = { ...base.issue, planStatus: "approved" as const };
    expect(states({ issue: approved, jobs: [{ kind: "implement", status: "running" }, { kind: "split", status: "succeeded" }] }).code).toBe("current: Writing code");
    expect(states({ issue: approved, parts: { done: 1, total: 3 } }).code).toBe("current: 1 of 3 parts merged");
    const mr = { status: "open" as const, files: 3, targetBranch: "main" };
    const withMr = states({ issue: approved, mergeRequest: mr, pipeline: { status: "manual", jobs: [] } });
    expect(withMr).toMatchObject({ code: "done: 3 files changed", test: "waiting: Waiting for you to start it", review: "waiting: Waiting for your review" });
    const failing = states({
      issue: approved,
      mergeRequest: mr,
      pipeline: { status: "failed", jobs: [{ status: "failed", allowFailure: false }, { status: "success", allowFailure: false }] as never },
    });
    expect(failing.test).toBe("failed: 1 check failed");
  });

  it("finishes at merge, and handles closed MRs and skipped plans", () => {
    const merged = states({ issue: { ...base.issue, planStatus: "auto" }, mergeRequest: { status: "merged", files: 1, targetBranch: "main" } });
    expect(merged).toMatchObject({ plan: "done: Planned", review: "done: Approved", merge: "done: Merged into main", test: "skipped: No pipeline" });
    expect(states({ mergeRequest: { status: "closed", files: 1, targetBranch: "main" } }).merge).toBe("skipped: Not merged");
    expect(states({ issue: { ...base.issue, origin: "split" } }).plan).toBe("skipped: Not needed");
  });
});

describe("story endpoint", () => {
  let app: App;
  let cleanup: () => Promise<void>;
  let cookie: string;
  beforeAll(async () => {
    ({ app, cleanup } = await createTestApp());
    ({ cookie } = await signUp(app));
    const post = (url: string, payload: object) => app.inject({ method: "POST", url, payload, headers: { cookie } });
    await post("/api/workspaces", { name: "Acme", slug: "acme" });
    await post("/api/workspaces/acme/projects", { name: "API", slug: "api", initReadme: true });
    await post("/api/projects/acme/api/issues", { title: "Add login" });
    await post("/api/projects/acme/api/issues/1/comments", { body: "Let's do this" });
  });
  afterAll(() => cleanup());

  it("returns the issue, steps and a timeline", async () => {
    const res = await app.inject({ url: "/api/projects/acme/api/issues/1/story", headers: { cookie } });
    const story = res.json().story as WorkItemStory;
    expect(story.issue.title).toBe("Add login");
    expect(story.steps.map((s) => s.key)).toEqual(["spec", "plan", "code", "test", "review", "merge"]);
    expect(story.mergeRequest).toBeNull();
    expect(story.timeline.map((t) => [t.actor, t.text])).toEqual([
      ["justin", "Opened the issue"],
      ["justin", "Let's do this"],
    ]);
  });
});

describe("activity", () => {
  let app: App;
  let cleanup: () => Promise<void>;
  let cookie: string;
  beforeAll(async () => {
    ({ app, cleanup } = await createTestApp());
    ({ cookie } = await signUp(app));
    const post = (url: string, payload: object) => app.inject({ method: "POST", url, payload, headers: { cookie } });
    await post("/api/workspaces", { name: "Acme", slug: "acme" });
    await post("/api/workspaces/acme/projects", { name: "API", slug: "api", initReadme: true });
    await post("/api/projects/acme/api/issues", { title: "First" });
    await post("/api/projects/acme/api/issues/1/comments", { body: "On it\nmore detail" });
  });
  afterAll(() => cleanup());

  it("lists who did what, newest first, filtered by actor and repo", async () => {
    const get = async (q = "") => (await app.inject({ url: `/api/activity${q}`, headers: { cookie } })).json().entries as { actor: string; text: string; href: string }[];
    const all = await get();
    // Both can land in the same millisecond, so don't depend on their order.
    expect(all.map((e) => e.text).sort()).toEqual(["commented on #1: On it", "opened #1 First"]);
    expect(all.find((e) => e.text.startsWith("commented"))).toMatchObject({ actor: "justin", bot: false, project: "acme/api", href: "/acme/api/issues/1" });
    expect(await get("?actor=agents")).toEqual([]);
    expect(await get("?project=acme/other")).toEqual([]);
  });
});
