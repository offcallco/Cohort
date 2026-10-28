import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jobs, users } from "@cohort/db";
import type { Job } from "@cohort/shared";
import { createAdapter } from "../../runner/src/agents/index.ts";
import { RunnerClient } from "../../runner/src/client.ts";
import type { AgentConfig, RunnerConfig } from "../../runner/src/config.ts";
import { sha256 } from "../src/auth.ts";
import { userForJobToken } from "../src/runners/hub.ts";
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
const git = async (cwd: string, ...args: string[]) =>
  (await run("git", ["-c", "init.defaultBranch=main", ...args], { cwd, env: gitEnv })).stdout;

let app: App;
let db: Awaited<ReturnType<typeof createTestApp>>["db"];
let tmp: string;
let cleanup: () => Promise<void>;
let cookie: string;
let origin: string;
let token: string;
let client: RunnerClient | null = null;

const call = async (method: "GET" | "POST" | "PATCH", url: string, payload?: object) => {
  const res = await app.inject({ method, url, payload, headers: { cookie } });
  return { status: res.statusCode, body: res.statusCode === 204 ? null : res.json() };
};

const until = async <T>(check: () => Promise<T | undefined | null | false>, what: string, ms = 15_000): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

const issueJobs = async (n: number): Promise<Job[]> =>
  (await call("GET", `/api/projects/acme/app/issues/${n}/jobs`)).body.jobs;

const finishedJob = (n: number) =>
  until(async () => {
    const [latest] = await issueJobs(n);
    return latest && !["queued", "running"].includes(latest.status) ? latest : null;
  }, `issue #${n}'s job to finish`);

// Agents are shell scripts in these tests; the "script-bot" user runs them.
const script = (name: string, command: string, limit = 1): AgentConfig => ({
  name,
  type: "command",
  command,
  limit,
  args: [],
  permission_mode: "acceptEdits",
});

async function startRunner(agent: AgentConfig, concurrent = 2) {
  await client?.stop();
  const created = await call("POST", "/api/runners", { name: `runner-${agent.name}` });
  const config: RunnerConfig = {
    url: `http://${origin}`,
    token: created.body.token,
    concurrent,
    agents: [agent],
    context: { instructions: "Be brief." },
    dataDir: join(tmp, `runner-${agent.name}`),
  };
  client = new RunnerClient(config, [createAdapter(agent)], { info: () => {}, error: () => {} });
  client.start();
  await until(async () => {
    const res = await call("GET", "/api/runners");
    return res.body.runners.find((r: { name: string; online: boolean }) => r.name === `runner-${agent.name}` && r.online);
  }, "runner to connect");
}

async function newIssue(title: string, body = "") {
  return (await call("POST", "/api/projects/acme/app/issues", { title, body })).body.issue.number as number;
}

beforeAll(async () => {
  const created = await createTestApp({ graceMs: 500 });
  ({ app, tmp, cleanup, db } = created);
  ({ cookie } = await signUp(app));
  token = (await call("POST", "/api/tokens", { name: "git" })).body.token.token;
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  origin = `127.0.0.1:${address.port}`;

  await call("POST", "/api/workspaces", { name: "Acme", slug: "acme" });
  await call("POST", "/api/workspaces/acme/projects", { name: "App", slug: "app", initReadme: true });
  await call("PATCH", "/api/projects/acme/app", { runnerContext: "Use tabs." });
  db.insert(users).values({ username: "script-bot", passwordHash: "", kind: "bot", agentType: "command" }).run();
}, 30_000);

afterAll(async () => {
  await client?.stop();
  await cleanup();
});

describe("agent jobs", () => {
  it("lists the built-in bots", async () => {
    const bots = (await call("GET", "/api/bots")).body.bots.map((b: { username: string }) => b.username);
    expect(bots).toEqual(["claude-bot", "codex-bot", "script-bot"]);
  });

  it("doesn't let bots sign in or take the setup", async () => {
    const res = await app.inject({ method: "POST", url: "/api/login", payload: { username: "claude-bot", password: "whatever123" } });
    expect(res.statusCode).toBe(401);
  });

  it("queues jobs for agents no runner offers and explains why", async () => {
    const n = await newIssue("Needs codex");
    await call("PATCH", `/api/projects/acme/app/issues/${n}`, { assignee: "codex-bot" });
    const [job] = await issueJobs(n);
    expect(job).toMatchObject({ status: "queued", bot: "codex-bot", waitingReason: "No runner with codex is online" });
    await call("PATCH", `/api/projects/acme/app/issues/${n}`, { assignee: null });
    expect((await issueJobs(n))[0]!.status).toBe("canceled");
  });

  it("runs an issue through to a merge request and merges it", async () => {
    // The prompt reaches the agent: write it into the repo so the test can check it.
    await startRunner(script("writer", 'printf "%s" "$COHORT_PROMPT" > prompt.txt && echo "Wrote the prompt to prompt.txt"'));
    const n = await newIssue("Add a prompt file", "Put the prompt in prompt.txt");
    const assigned = await call("PATCH", `/api/projects/acme/app/issues/${n}`, { assignee: "script-bot", labels: ["docs"] });
    expect(assigned.status).toBe(200);

    const job = await finishedJob(n);
    expect(job).toMatchObject({
      status: "succeeded",
      summary: "Wrote the prompt to prompt.txt",
      mergeRequest: 1,
      branch: `cohort/${n}-add-a-prompt-file`,
    });
    const log = await app.inject({ method: "GET", url: `/api/jobs/${job.id}/log`, headers: { cookie } });
    expect(log.body).toContain("Wrote the prompt to prompt.txt");
    expect(log.body).toContain("Job succeeded");

    const issue = (await call("GET", `/api/projects/acme/app/issues/${n}`)).body.issue;
    expect(issue.status).toBe("review");
    expect(issue.commentList.at(-1)).toMatchObject({ author: { username: "script-bot", kind: "bot" } });
    expect(issue.commentList.at(-1).body).toContain("Opened !1");

    const mr = (await call("GET", "/api/projects/acme/app/merge_requests/1")).body.mergeRequest;
    expect(mr).toMatchObject({
      title: 'Resolve "Add a prompt file"',
      status: "open",
      mergeable: true,
      author: { username: "script-bot" },
      issue: { number: n },
      targetBranch: "main",
    });
    expect(mr.commits[0]).toMatchObject({ subject: `Add a prompt file (#${n})`, authorName: "script-bot" });
    expect(mr.files.map((f: { newPath: string }) => f.newPath)).toEqual(["prompt.txt"]);
    expect(mr.jobs.map((j: Job) => j.id)).toEqual([job.id]);

    const prompt = (await call("GET", `/api/projects/acme/app/blob?ref=${encodeURIComponent(job.branch)}&path=prompt.txt`)).body.blob.content;
    expect(prompt).toContain(`issue #${n} in acme/app: Add a prompt file`);
    expect(prompt).toContain("Put the prompt in prompt.txt");
    expect(prompt).toContain("Labels: docs");
    expect(prompt).toContain("Use tabs.");
    expect(prompt).toContain("Be brief.");

    const merged = await call("POST", "/api/projects/acme/app/merge_requests/1/merge", { deleteSourceBranch: true });
    expect(merged.body.mergeRequest).toMatchObject({ status: "merged", mergeable: null });
    expect(merged.body.mergeRequest.files.map((f: { newPath: string }) => f.newPath)).toEqual(["prompt.txt"]);
    expect((await call("GET", `/api/projects/acme/app/issues/${n}`)).body.issue.status).toBe("done");
    const tree = (await call("GET", "/api/projects/acme/app/tree")).body.entries.map((e: { name: string }) => e.name);
    expect(tree).toContain("prompt.txt");
    const branches = (await call("GET", "/api/projects/acme/app")).body.branches.map((b: { name: string }) => b.name);
    expect(branches).toEqual(["main"]);
  }, 30_000);

  it("fails jobs that change nothing, and retries them", async () => {
    await startRunner(script("noop", "echo nothing to do"));
    const n = await newIssue("Do nothing");
    await call("PATCH", `/api/projects/acme/app/issues/${n}`, { assignee: "script-bot" });
    const job = await finishedJob(n);
    expect(job).toMatchObject({ status: "failed", error: "The agent finished without changing any files" });
    const issue = (await call("GET", `/api/projects/acme/app/issues/${n}`)).body.issue;
    expect(issue.status).toBe("blocked");
    expect(issue.commentList.at(-1).body).toContain(`Job #${job.id} failed`);

    await startRunner(script("fixer", "echo fixed > fix.txt && echo Fixed it"));
    const retried = await call("POST", `/api/jobs/${job.id}/retry`);
    expect(retried.status).toBe(201);
    const second = await finishedJob(n);
    expect(second).toMatchObject({ status: "succeeded", branch: job.branch });
  }, 30_000);

  it("cancels a running job", async () => {
    await startRunner(script("sleeper", "sleep 30; echo late > late.txt"));
    const n = await newIssue("Take forever");
    await call("PATCH", `/api/projects/acme/app/issues/${n}`, { assignee: "script-bot" });
    const running = await until(async () => {
      const [j] = await issueJobs(n);
      return j?.status === "running" ? j : null;
    }, "job to start");
    await new Promise((r) => setTimeout(r, 300));
    await call("POST", `/api/jobs/${running.id}/cancel`);
    const job = await finishedJob(n);
    expect(job.status).toBe("canceled");
    expect((await call("GET", `/api/projects/acme/app/issues/${n}`)).body.issue.status).toBe("todo");
  }, 30_000);

  it("respects the agent's limit and runs the rest after", async () => {
    // Each job writes its own file so the branches don't conflict.
    await startRunner(script("limited", 'sleep 0.5; echo "$COHORT_PROMPT" | head -1 > "$(date +%s%N).txt"; echo done'), 3);
    const a = await newIssue("Limit A");
    const b = await newIssue("Limit B");
    await call("PATCH", `/api/projects/acme/app/issues/${a}`, { assignee: "script-bot" });
    await call("PATCH", `/api/projects/acme/app/issues/${b}`, { assignee: "script-bot" });
    await until(async () => (await issueJobs(a))[0]?.status === "running", "first job to run");
    const [second] = await issueJobs(b);
    expect(second).toMatchObject({ status: "queued", waitingReason: "Waiting for a free slot on a runner" });
    expect((await finishedJob(a)).status).toBe("succeeded");
    expect((await finishedJob(b)).status).toBe("succeeded");
  }, 30_000);

  it("fails running jobs when the runner disappears", async () => {
    await startRunner(script("vanishing", "sleep 30"));
    const n = await newIssue("Lose the runner");
    await call("PATCH", `/api/projects/acme/app/issues/${n}`, { assignee: "script-bot" });
    await until(async () => (await issueJobs(n))[0]?.status === "running", "job to start");
    // Drop the connection without the runner reporting back.
    const runnersList = (await call("GET", "/api/runners")).body.runners;
    const runner = runnersList.find((r: { name: string }) => r.name === "runner-vanishing");
    app.hub.disconnect(runner.id);
    const job = await finishedJob(n);
    expect(job).toMatchObject({ status: "failed" });
  }, 30_000);
});

describe("job tokens", () => {
  it("only work for their own project while the job runs", () => {
    const projectId = 1;
    db.insert(jobs)
      .values({
        projectId,
        kind: "implement",
        botId: 1,
        agentType: "command",
        branch: "x",
        baseBranch: "main",
        status: "running",
        tokenHash: sha256("cohort_job_test"),
      })
      .run();
    expect(userForJobToken(db, "cohort_job_test", projectId)).toMatchObject({ kind: "bot" });
    expect(userForJobToken(db, "cohort_job_test", 999)).toBeNull();
    expect(userForJobToken(db, "cohort_job_other", projectId)).toBeNull();
  });
});

describe("merge requests", () => {
  it("detects conflicts and refuses to merge them", async () => {
    const work = join(tmp, "conflict");
    mkdirSync(work);
    const url = `http://x:${token}@${origin}/acme/app.git`;
    await git(work, "clone", "--quiet", url, "repo");
    const repo = join(work, "repo");
    await git(repo, "checkout", "-q", "-b", "left");
    writeFileSync(join(repo, "README.md"), "left\n");
    await git(repo, "commit", "-qam", "left");
    await git(repo, "push", "-q", "origin", "left");
    await git(repo, "checkout", "-q", "main");
    writeFileSync(join(repo, "README.md"), "right\n");
    await git(repo, "commit", "-qam", "right");
    await git(repo, "push", "-q", "origin", "main");

    const created = await call("POST", "/api/projects/acme/app/merge_requests", {
      title: "Left",
      sourceBranch: "left",
      targetBranch: "main",
    });
    expect(created.body.mergeRequest).toMatchObject({ mergeable: false, status: "open" });
    const n = created.body.mergeRequest.number;
    const merge = await call("POST", `/api/projects/acme/app/merge_requests/${n}/merge`, {});
    expect(merge).toEqual({ status: 409, body: { error: "The branches have conflicts" } });

    expect((await call("POST", `/api/projects/acme/app/merge_requests/${n}/close`)).body.mergeRequest.status).toBe("closed");
    expect((await call("POST", `/api/projects/acme/app/merge_requests/${n}/comments`, { body: "Closing" })).body.mergeRequest.comments).toHaveLength(1);
    const list = (await call("GET", "/api/projects/acme/app/merge_requests?status=closed")).body.mergeRequests;
    expect(list.map((m: { title: string }) => m.title)).toEqual(["Left"]);
  }, 30_000);

  it("rejects bad branches", async () => {
    const res = await call("POST", "/api/projects/acme/app/merge_requests", {
      title: "x",
      sourceBranch: "nope",
      targetBranch: "main",
    });
    expect(res).toEqual({ status: 400, body: { error: 'Branch "nope" not found' } });
  });

  it("won't assign an agent to an empty repo", async () => {
    await call("POST", "/api/workspaces/acme/projects", { name: "Empty", slug: "empty" });
    const res = await call("POST", "/api/projects/acme/empty/issues", { title: "x", assignee: "claude-bot" });
    expect(res).toEqual({ status: 400, body: { error: "Push at least one commit before assigning an agent" } });
  });
});
