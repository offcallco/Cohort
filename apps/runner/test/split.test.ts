import { describe, expect, it } from "vitest";
import type { JobSpec } from "@cohort/shared";
import { implementPrompt, planPrompt } from "../src/prompt.ts";

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
  issue: { number: 3, title: "Login", body: "Add login", labels: [], plan: null },
  instruction: null,
  context: "",
  bot: { name: "bot", email: "bot@x" },
};

describe("plan prompt", () => {
  it("asks for a plan and an optional split within the limit", () => {
    const prompt = planPrompt(job, "", 3);
    expect(prompt).toContain("Issue #3 in acme/api: Login");
    expect(prompt).toContain("Don't write any code yet");
    expect(prompt).toContain("anything you're unsure about");
    expect(prompt).toContain("at most 3 sub-issues");
    expect(prompt).toContain("Most issues should NOT be split");
    expect(prompt).toContain("<plan>");
    expect(prompt).toContain("<issues>");
    expect(prompt).not.toContain("secret");
  });

  it("plans without splitting when splitting is off", () => {
    const prompt = planPrompt(job, "", 0);
    expect(prompt).toContain("Don't split the issue");
    expect(prompt).not.toContain("sub-issues");
  });

  it("revises the previous plan with the reviewer's feedback", () => {
    const prompt = planPrompt({ ...job, instruction: "Use Redis, not memory", issue: { ...job.issue!, plan: "Store attempts in memory" } }, "", 3);
    expect(prompt).toContain("Your previous plan:\n\nStore attempts in memory");
    expect(prompt).toContain("asked for changes:\n\nUse Redis, not memory");
  });
});

describe("implement prompt", () => {
  it("includes the approved plan and requested changes", () => {
    const prompt = implementPrompt(
      { ...job, kind: "implement", branchExists: true, instruction: "Rename the helper", issue: { ...job.issue!, plan: "Add a limiter" } },
      "",
    );
    expect(prompt).toContain("The approved plan:\n\nAdd a limiter");
    expect(prompt).toContain("reviewed your earlier work on this branch and asked for changes:\n\nRename the helper");
  });
});
