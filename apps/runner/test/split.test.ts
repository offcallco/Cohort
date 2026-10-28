import { describe, expect, it } from "vitest";
import type { JobSpec } from "@cohort/shared";
import type { AgentAdapter } from "../src/agents/index.ts";
import { KeyedLock } from "../src/git.ts";
import { runSplitJob } from "../src/job.ts";
import { splitPrompt } from "../src/prompt.ts";

const job: JobSpec = {
  id: 7,
  kind: "split",
  agent: "command",
  project: "acme/api",
  clonePath: "/acme/api.git",
  token: "secret",
  branch: "cohort/3-login",
  baseBranch: "main",
  branchExists: false,
  issue: { number: 3, title: "Login", body: "Add login", labels: [] },
  context: "",
  bot: { name: "bot", email: "bot@x" },
};

describe("split jobs", () => {
  it("don't run the agent when splitting is off", async () => {
    let called = false;
    const adapter = { plan: async () => ((called = true), { text: "", sessionId: null }) } as unknown as AgentAdapter;
    const outcome = await runSplitJob(job, {
      serverUrl: "http://unused",
      dataDir: "/nonexistent",
      instructions: "",
      split: { max_subtasks: 3, max_depth: 0 },
      adapter,
      signal: new AbortController().signal,
      log: () => {},
      locks: new KeyedLock(),
    });
    expect(outcome).toEqual({ status: "succeeded", summary: "<issues>[]</issues>", maxSubtasks: 3 });
    expect(called).toBe(false);
  });

  it("tell the agent the limit and the reply format", () => {
    const prompt = splitPrompt(job, "", 3);
    expect(prompt).toContain("Issue #3 in acme/api: Login");
    expect(prompt).toContain("at most 3 sub-issues");
    expect(prompt).toContain("Most issues should NOT be split");
    expect(prompt).toContain("<issues>");
    expect(prompt).not.toContain("secret");
  });
});
