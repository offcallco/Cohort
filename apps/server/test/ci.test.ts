import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pipelineJobs, pipelines as pipelinesTable, users } from "@cohort/db";
import type { PipelineDetail, PipelineSummary } from "@cohort/shared";
import { createAdapter } from "../../runner/src/agents/index.ts";
import { ciScript } from "../../runner/src/ci.ts";
import { RunnerClient } from "../../runner/src/client.ts";
import type { AgentConfig, RunnerConfig } from "../../runner/src/config.ts";
import { sha256 } from "../src/auth.ts";
import { CiConfigError, parseCiConfig } from "../src/pipelines/config.ts";
import { createTestApp, signUp, type App } from "./helpers.ts";

const run = promisify(execFile);
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};
const git = async (cwd: string, ...args: string[]) => (await run("git", ["-c", "init.defaultBranch=main", ...args], { cwd, env: gitEnv })).stdout;

let app: App;
let db: Awaited<ReturnType<typeof createTestApp>>["db"];
let tmp: string;
let cleanup: () => Promise<void>;
let cookie: string;
let token: string;
let origin: string;
let client: RunnerClient | null = null;

const call = async (method: "GET" | "POST" | "PATCH", url: string, payload?: object) => {
  const res = await app.inject({ method, url, payload, headers: { cookie } });
  return { status: res.statusCode, body: res.json() };
};

const until = async <T>(check: () => Promise<T | undefined | null | false>, what: string, ms = 20_000): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

async function startRunner(options: { ci: boolean; agent?: AgentConfig }) {
  await client?.stop();
  const name = `ci-runner-${Date.now()}`;
  const created = await call("POST", "/api/runners", { name });
  const config: RunnerConfig = {
    url: `http://${origin}`,
    token: created.body.token,
    concurrent: 3,
    agents: options.agent ? [options.agent] : [],
    context: { instructions: "" },
    split: { max_subtasks: 4, max_depth: 0 },
    ci: { enabled: options.ci, timeout_minutes: 1 },
    dataDir: join(tmp, name),
  };
  client = new RunnerClient(config, options.agent ? [createAdapter(options.agent)] : [], { info: () => {}, error: () => {} });
  client.start();
  await until(async () => (await call("GET", "/api/runners")).body.runners.find((r: { name: string; online: boolean }) => r.name === name && r.online), "runner");
}

// A project with a local clone to push from.
let projectCount = 0;
async function newProject() {
  const slug = `ci${++projectCount}`;
  await call("POST", "/api/workspaces/acme/projects", { name: slug, slug });
  const dir = join(tmp, "work", slug);
  mkdirSync(dir, { recursive: true });
  await git(dir, "init", "-q");
  const url = `http://x:${token}@${origin}/acme/${slug}.git`;
  const api = `/api/projects/acme/${slug}`;
  return {
    api,
    dir,
    async push(files: Record<string, string>, branch = "main") {
      for (const [path, content] of Object.entries(files)) writeFileSync(join(dir, path), content);
      await git(dir, "add", "-A");
      await git(dir, "commit", "-q", "--allow-empty", "-m", `update ${Object.keys(files).join(", ")}`);
      await git(dir, "push", "-q", url, `HEAD:refs/heads/${branch}`);
      return (await git(dir, "rev-parse", "HEAD")).trim();
    },
    list: async () => (await call("GET", `${api}/pipelines`)).body.pipelines as PipelineSummary[],
    get: async (id: number) => (await call("GET", `${api}/pipelines/${id}`)).body.pipeline as PipelineDetail,
    settled: (id: number) =>
      until(async () => {
        const p = (await call("GET", `${api}/pipelines/${id}`)).body.pipeline as PipelineDetail;
        return ["success", "failed", "canceled"].includes(p.status) ? p : null;
      }, `pipeline ${id}`),
    log: async (jobId: number) => (await app.inject({ method: "GET", url: `/api/ci_jobs/${jobId}/log`, headers: { cookie } })).body,
  };
}

const CI_FILE = `
stages: [build, test, deploy]
variables:
  GREETING: hello
build:
  stage: build
  script:
    - echo "$GREETING from $CI_JOB_NAME on $CI_COMMIT_REF_NAME"
    - test -f README.md
unit:
  stage: test
  script: echo unit ok
flaky:
  stage: test
  allow_failure: true
  script: exit 3
deploy:
  stage: deploy
  script: echo "deployed $CI_COMMIT_SHORT_SHA"
.template:
  script: echo hidden
`;

beforeAll(async () => {
  ({ app, tmp, cleanup, db } = await createTestApp({ graceMs: 500 }));
  ({ cookie } = await signUp(app));
  db.insert(users).values({ username: "script-bot", passwordHash: "", kind: "bot", agentType: "command" }).run();
  token = (await call("POST", "/api/tokens", { name: "git" })).body.token.token;
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  origin = `127.0.0.1:${address.port}`;
  await call("POST", "/api/workspaces", { name: "Acme", slug: "acme" });
  await startRunner({ ci: true });
}, 30_000);

afterAll(async () => {
  await client?.stop();
  await cleanup();
});

describe("pipelines on push", () => {
  it("runs stages in order, honours allow_failure and passes CI variables", async () => {
    const p = await newProject();
    const sha = await p.push({ "README.md": "# hi\n", ".cohort-ci.yml": CI_FILE });
    const [created] = await until(async () => {
      const list = await p.list();
      return list.length ? list : null;
    }, "pipeline to be created");
    expect(created).toMatchObject({ ref: "main", sha, source: "push", triggeredBy: "justin" });

    const done = await p.settled(created!.id);
    expect(done.status).toBe("success");
    expect(done.stages).toEqual(["build", "test", "deploy"]);
    expect(done.jobs.map((j) => [j.name, j.status])).toEqual([
      ["build", "success"],
      ["unit", "success"],
      ["flaky", "failed"],
      ["deploy", "success"],
    ]);
    const build = await p.log(done.jobs[0]!.id);
    expect(build).toContain('$ echo "$GREETING from $CI_JOB_NAME on $CI_COMMIT_REF_NAME"');
    expect(build).toContain("hello from build on main");
    expect(await p.log(done.jobs[3]!.id)).toContain(`deployed ${sha.slice(0, 8)}`);
    expect(done.jobs[2]!.error).toBe("Script exited with code 3");
  }, 40_000);

  it("skips later stages after a failure", async () => {
    const p = await newProject();
    await p.push({ ".cohort-ci.yml": "lint:\n  stage: build\n  script: [echo linting, 'false', echo never]\ntest:\n  script: echo tests\n" });
    const [created] = await until(async () => ((await p.list()).length ? p.list() : null), "pipeline");
    const done = await p.settled(created!.id);
    expect(done.status).toBe("failed");
    expect(done.jobs.map((j) => [j.name, j.status])).toEqual([
      ["lint", "failed"],
      ["test", "skipped"],
    ]);
    const log = await p.log(done.jobs[0]!.id);
    expect(log).toContain("linting");
    expect(log).not.toContain("\nnever");
  }, 30_000);

  it("reports a broken config and ignores repos without one", async () => {
    const p = await newProject();
    await p.push({ "notes.txt": "no ci here\n" });
    await new Promise((r) => setTimeout(r, 300));
    expect(await p.list()).toEqual([]);

    await p.push({ ".cohort-ci.yml": "test:\n  stage: nope\n  script: echo x\n" });
    const [broken] = await until(async () => ((await p.list()).length ? p.list() : null), "pipeline");
    expect(broken).toMatchObject({ status: "failed", error: 'Job "test" uses stage "nope", which isn\'t in stages (build, test, deploy)' });
  }, 30_000);

  it("cancels a running pipeline", async () => {
    const p = await newProject();
    await p.push({ ".cohort-ci.yml": "slow:\n  script: sleep 30\nafter:\n  stage: deploy\n  script: echo after\n" });
    const [created] = await until(async () => ((await p.list()).length ? p.list() : null), "pipeline");
    await until(async () => (await p.get(created!.id)).jobs[0]!.status === "running", "job to start");
    await call("POST", `${p.api}/pipelines/${created!.id}/cancel`);
    const done = await p.settled(created!.id);
    expect(done.status).toBe("canceled");
    await until(async () => (await p.get(created!.id)).jobs.every((j) => j.status === "canceled"), "jobs to be canceled");

    const retried = await call("POST", `${p.api}/pipelines/${created!.id}/retry`);
    expect(retried.status).toBe(201);
    await call("POST", `${p.api}/pipelines/${retried.body.pipeline.id}/cancel`);
  }, 30_000);
});

describe("merge requests", () => {
  const ciFile = "test:\n  script: test \"$(cat answer.txt)\" = 42\n";

  it("waits for a person to start pipelines on agents' MRs, and gates merging", async () => {
    await startRunner({
      ci: true,
      agent: { name: "writer", type: "command", command: "echo 42 > answer.txt && echo wrote it", limit: 1, args: [], permission_mode: "acceptEdits" },
    });
    const p = await newProject();
    await p.push({ "README.md": "# app\n", ".cohort-ci.yml": ciFile, "answer.txt": "0\n" });
    await call("PATCH", p.api, { pipelinesMustSucceed: true });

    const issue = (await call("POST", `${p.api}/issues`, { title: "Fix the answer", assignee: "script-bot" })).body.issue;
    await until(async () => (await call("GET", `${p.api}/issues/${issue.number}`)).body.issue.status === "review", "agent MR");

    const mr = (await call("GET", `${p.api}/merge_requests/1`)).body.mergeRequest;
    expect(mr.pipelinesMustSucceed).toBe(true);
    expect(mr.pipeline).toMatchObject({ status: "manual", source: "merge_request", ref: mr.sourceBranch, mergeRequest: 1 });
    expect((await call("POST", `${p.api}/merge_requests/1/merge`, {})).body.error).toBe("The pipeline must succeed first (it's manual)");

    await call("POST", `${p.api}/pipelines/${mr.pipeline.id}/run`);
    expect((await p.settled(mr.pipeline.id)).status).toBe("success");
    expect((await call("POST", `${p.api}/merge_requests/1/merge`, {})).body.mergeRequest.status).toBe("merged");

    // Merging is a push to main, which gets its own pipeline.
    const mainPipelines = (await p.list()).filter((x) => x.ref === "main" && x.source === "push");
    expect(mainPipelines.length).toBe(2);
  }, 40_000);

  it("runs agents' MR pipelines straight away when the project allows it", async () => {
    const p = await newProject();
    await p.push({ "README.md": "# app\n", ".cohort-ci.yml": ciFile, "answer.txt": "0\n" });
    await call("PATCH", p.api, { autoRunAgentPipelines: true });
    const issue = (await call("POST", `${p.api}/issues`, { title: "Fix it again", assignee: "script-bot" })).body.issue;
    await until(async () => (await call("GET", `${p.api}/issues/${issue.number}`)).body.issue.status === "review", "agent MR");
    const mr = (await call("GET", `${p.api}/merge_requests/1`)).body.mergeRequest;
    expect(mr.pipeline.status).not.toBe("manual");
    expect((await p.settled(mr.pipeline.id)).status).toBe("success");
  }, 40_000);
});

describe("runners and tokens", () => {
  it("queues CI jobs when no runner takes them", async () => {
    await startRunner({ ci: false });
    const p = await newProject();
    await p.push({ ".cohort-ci.yml": "test:\n  script: echo hi\n" });
    const [created] = await until(async () => ((await p.list()).length ? p.list() : null), "pipeline");
    const detail = await p.get(created!.id);
    expect(detail.jobs[0]).toMatchObject({ status: "pending", waitingReason: "No runner that takes CI jobs is online" });
    await call("POST", `${p.api}/pipelines/${created!.id}/cancel`);
    await startRunner({ ci: true });
  }, 30_000);

  it("lets CI tokens clone but not push", async () => {
    const p = await newProject();
    await p.push({ "README.md": "# x\n" });
    const projectId = (await call("GET", p.api)).body.project.id;
    const row = db.insert(pipelinesTable).values({ projectId, ref: "main", sha: "x", status: "running", source: "web", triggeredById: 1 }).returning().get();
    db.insert(pipelineJobs)
      .values({ pipelineId: row.id, name: "t", stage: "test", stageIndex: 1, script: "[]", status: "running", tokenHash: sha256("cohort_ci_test") })
      .run();
    const header = ["-c", "credential.helper=", "-c", "http.extraHeader=Authorization: Bearer cohort_ci_test"];
    const url = `http://${origin}/acme/${p.api.split("/").pop()}.git`;
    await git(tmp, ...header, "clone", "-q", url, join(tmp, `ci-clone-${projectCount}`));
    await expect(git(p.dir, ...header, "push", "-q", url, "HEAD:refs/heads/sneaky")).rejects.toThrow(/403|CI jobs can't push/);
  }, 30_000);
});

describe("parseCiConfig", () => {
  it("reads stages, jobs, variables and hidden jobs", () => {
    const config = parseCiConfig(CI_FILE);
    expect(config.stages).toEqual(["build", "test", "deploy"]);
    expect(config.jobs.map((j) => j.name)).toEqual(["build", "unit", "flaky", "deploy"]);
    expect(config.jobs[0]).toMatchObject({ stageIndex: 0, variables: { GREETING: "hello" } });
    expect(config.jobs[2]).toMatchObject({ allowFailure: true, script: ["exit 3"] });
  });

  it("defaults to GitLab's stages and the test stage", () => {
    expect(parseCiConfig("a:\n  script: echo\n")).toMatchObject({ stages: ["test"], jobs: [{ stage: "test", stageIndex: 1 }] });
  });

  it("explains mistakes", () => {
    const error = (text: string) => {
      try {
        parseCiConfig(text);
        return null;
      } catch (e) {
        expect(e).toBeInstanceOf(CiConfigError);
        return (e as Error).message;
      }
    };
    expect(error("a: [")).toMatch(/isn't valid YAML/);
    expect(error("a:\n  stage: test\n")).toBe('Job "a" needs a script: a command or a list of commands');
    expect(error("stages: [x]\n")).toBe(".cohort-ci.yml has no jobs");
    expect(error("a:\n  script: x\n  allow_failure: maybe\n")).toBe('Job "a": allow_failure must be true or false');
    expect(error("variables:\n  1BAD: x\na:\n  script: x\n")).toMatch(/isn't a valid variable name/);
  });
});

describe("ciScript", () => {
  it("echoes each command, quoting safely, and stops at the first failure", () => {
    const script = ciScript(["echo 'it''s'", "make test"]);
    expect(script.split("\n")[0]).toBe("set -e");
    expect(script).toContain(`printf '%s\\n' '$ echo '\\''it'\\'''\\''s'\\'''`);
    expect(script).toContain("make test");
  });
});
