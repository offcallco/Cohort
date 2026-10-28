import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { failureExcerpt } from "../src/pipelines/service.ts";
import { createTestApp, signUp, type App } from "./helpers.ts";

const run = promisify(execFile);
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const git = (cwd: string, ...a: string[]) => run("git", ["-c", "init.defaultBranch=main", ...a], { cwd, env: gitEnv });

let app: App;
let tmp: string;
let cleanup: () => Promise<void>;
let cookie: string;
const call = async (method: "GET" | "POST", url: string, payload?: object) => {
  const res = await app.inject({ method, url, payload, headers: { cookie } });
  return { status: res.statusCode, body: res.json() };
};

beforeAll(async () => {
  ({ app, tmp, cleanup } = await createTestApp());
  ({ cookie } = await signUp(app));
  const token = (await call("POST", "/api/tokens", { name: "git" })).body.token.token;
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as { port: number }).port;
  await call("POST", "/api/workspaces", { name: "Acme", slug: "acme" });
  await call("POST", "/api/workspaces/acme/projects", { name: "API", slug: "api" });

  // main has app.js; the branch reindents it and changes one line.
  const work = join(tmp, "work");
  mkdirSync(work);
  const url = `http://x:${token}@127.0.0.1:${port}/acme/api.git`;
  await git(work, "init", "-q");
  writeFileSync(join(work, "app.js"), "function a() {\n  return 1;\n}\n");
  writeFileSync(join(work, "style.js"), "const x = 1;\n");
  await git(work, "add", "-A");
  await git(work, "commit", "-qm", "init");
  await git(work, "push", "-q", url, "HEAD:refs/heads/main");
  await git(work, "checkout", "-qb", "feature");
  writeFileSync(join(work, "app.js"), "function a() {\n  return 2;\n}\n");
  writeFileSync(join(work, "style.js"), "const x  =  1;\n");
  await git(work, "commit", "-qam", "change");
  await git(work, "push", "-q", url, "HEAD:refs/heads/feature");
  await call("POST", "/api/projects/acme/api/merge_requests", { title: "Feature", sourceBranch: "feature", targetBranch: "main" });
}, 30_000);

afterAll(() => cleanup());

describe("review", () => {
  it("can leave out whitespace-only changes", async () => {
    const all = (await call("GET", "/api/projects/acme/api/merge_requests/1")).body.mergeRequest;
    expect(all.files.map((f: { newPath: string }) => f.newPath).sort()).toEqual(["app.js", "style.js"]);
    const hidden = (await call("GET", "/api/projects/acme/api/merge_requests/1?whitespace=hide")).body.mergeRequest;
    expect(hidden.files.map((f: { newPath: string }) => f.newPath)).toEqual(["app.js"]);
  });

  it("stores comments on a line of the diff", async () => {
    const res = await call("POST", "/api/projects/acme/api/merge_requests/1/comments", { body: "Why 2?", path: "app.js", line: 2, side: "new" });
    expect(res.status).toBe(201);
    expect(res.body.mergeRequest.comments.at(-1)).toMatchObject({ body: "Why 2?", path: "app.js", line: 2, side: "new" });
    const general = await call("POST", "/api/projects/acme/api/merge_requests/1/comments", { body: "Looks fine" });
    expect(general.body.mergeRequest.comments.at(-1)).toMatchObject({ path: null, line: null });
    expect((await call("POST", "/api/projects/acme/api/merge_requests/1/comments", { body: "x", path: "app.js" })).status).toBe(400);
  });
});

describe("failureExcerpt", () => {
  it("keeps the last lines of output before the failure", () => {
    const log = ["Running on runner local", "Checking out main at abc", "$ npm test", "ok 1 - adds", "not ok 2 - refunds partial", "  timed out after 30s", "", "Job failed: Script exited with code 1"].join("\n");
    expect(failureExcerpt(log)).toBe("$ npm test\nok 1 - adds\nnot ok 2 - refunds partial\n  timed out after 30s");
    expect(failureExcerpt("Job failed: x")).toBeNull();
  });
});
