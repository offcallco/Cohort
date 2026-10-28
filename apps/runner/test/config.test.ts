import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { JobSpec } from "@cohort/shared";
import { loadConfig } from "../src/config.ts";
import { implementPrompt } from "../src/prompt.ts";

function writeConfig(text: string) {
  const dir = mkdtempSync(join(tmpdir(), "cohort-runner-"));
  const file = join(dir, "config.toml");
  writeFileSync(file, text);
  return { dir, file };
}

describe("loadConfig", () => {
  it("applies defaults and resolves the data folder", () => {
    const { dir, file } = writeConfig(`
url = "http://127.0.0.1:7700/"
token = "cohort_runner_x"

[[agents]]
name = "claude"
type = "claude-code"
`);
    const config = loadConfig(file);
    expect(config).toMatchObject({ url: "http://127.0.0.1:7700", concurrent: 2, dataDir: dir });
    expect(config.agents[0]).toMatchObject({ limit: 1, permission_mode: "acceptEdits", args: [] });
    expect(config.context.instructions).toBe("");
  });

  it("explains invalid configs", () => {
    expect(() => loadConfig(writeConfig(`url = "nope"\ntoken = "x"`).file)).toThrow(/url/);
    expect(() =>
      loadConfig(
        writeConfig(`url = "http://x"\ntoken = "x"\n[[agents]]\nname = "a"\ntype = "codex"\n[[agents]]\nname = "a"\ntype = "codex"`).file,
      ),
    ).toThrow(/duplicate agent name "a"/);
    expect(() => loadConfig(writeConfig(`url = "http://x"\ntoken = "x"\n[[agents]]\nname = "a"\ntype = "gpt"`).file)).toThrow(/type/);
  });
});

describe("implementPrompt", () => {
  const job: JobSpec = {
    id: 1,
    kind: "implement",
    agent: "claude-code",
    project: "acme/api",
    clonePath: "/acme/api.git",
    token: "secret",
    branch: "cohort/3-login",
    baseBranch: "main",
    branchExists: false,
    issue: { number: 3, title: "Login", body: "Add a login form", labels: ["ui"], plan: null },
    instruction: null,
    context: "Use tabs.",
    bot: { name: "claude-bot", email: "claude-bot@bots.cohort.local" },
  };

  it("includes the issue, both contexts and the ground rules, but never the token", () => {
    const prompt = implementPrompt(job, "Be brief.");
    expect(prompt).toContain("issue #3 in acme/api: Login");
    expect(prompt).toContain("Add a login form");
    expect(prompt).toContain("Labels: ui");
    expect(prompt).toContain("Use tabs.");
    expect(prompt).toContain("Be brief.");
    expect(prompt).toContain("based on main");
    expect(prompt).toContain("Don't push");
    expect(prompt).not.toContain("secret");
  });

  it("builds on the existing branch for retries", () => {
    expect(implementPrompt({ ...job, branchExists: true }, "")).toContain("based on cohort/3-login");
  });
});
