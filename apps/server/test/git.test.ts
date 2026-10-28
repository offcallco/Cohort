import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parsePatch } from "../src/git/repo.ts";
import { createTestApp, signUp, type App } from "./helpers.ts";

let app: App;
let tmp: string;
let cleanup: () => Promise<void>;
let cookie: string;
let token: string;
let origin: string;

// Isolated from the developer's git config and credential helpers.
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
// Async on purpose: the server under test runs in this process, so a sync exec would deadlock.
const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await run("git", ["-c", "init.defaultBranch=main", ...args], { cwd, env: gitEnv })).stdout;

const api = async (method: "GET" | "POST", url: string, payload?: object) => {
  const res = await app.inject({ method, url, payload, headers: { cookie } });
  return { status: res.statusCode, body: res.json() };
};

beforeAll(async () => {
  ({ app, tmp, cleanup } = await createTestApp());
  ({ cookie } = await signUp(app));
  const created = await app.inject({ method: "POST", url: "/api/tokens", headers: { cookie }, payload: { name: "git" } });
  token = created.json().token.token;
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  origin = `127.0.0.1:${address.port}`;

  expect((await api("POST", "/api/workspaces", { name: "Acme", slug: "acme" })).status).toBe(201);
});

afterAll(() => cleanup());

describe("workspaces and projects", () => {
  it("rejects reserved and duplicate slugs", async () => {
    expect((await api("POST", "/api/workspaces", { name: "API", slug: "api" })).status).toBe(400);
    expect((await api("POST", "/api/workspaces", { name: "Acme 2", slug: "acme" })).status).toBe(409);
    expect((await api("POST", "/api/workspaces", { name: "x", slug: "Bad Slug" })).status).toBe(400);
  });

  it("creates a project with a README commit", async () => {
    const res = await api("POST", "/api/workspaces/acme/projects", {
      name: "Docs",
      slug: "docs",
      description: "Team docs",
      initReadme: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.project).toMatchObject({ clonePath: "/acme/docs.git", defaultBranch: "main" });

    const tree = await api("GET", "/api/projects/acme/docs/tree");
    expect(tree.body.entries.map((e: { name: string }) => e.name)).toEqual(["README.md"]);
    expect(tree.body.readme.content).toBe("# Docs\n\nTeam docs\n");
  });

  it("lists workspaces with their projects", async () => {
    const res = await api("GET", "/api/workspaces");
    expect(res.body.workspaces[0]).toMatchObject({ slug: "acme", projects: [{ slug: "docs" }] });
  });
});

describe("git over HTTP", () => {
  let work: string;

  beforeAll(async () => {
    await api("POST", "/api/workspaces/acme/projects", { name: "API", slug: "api" });
    work = join(tmp, "work");
    mkdirSync(work);
  });

  it("refuses clone without a token", async () => {
    await expect(git(tmp, "clone", `http://${origin}/acme/api.git`, "anon")).rejects.toThrow(
      /Authentication failed|401|could not read Username/,
    );
  });

  it("refuses clone with a bad token", async () => {
    await expect(git(tmp, "clone", `http://x:cohort_nope@${origin}/acme/api.git`, "bad")).rejects.toThrow(
      /Authentication failed|401/,
    );
  });

  it("returns 404 for unknown repos", async () => {
    await expect(git(tmp, "clone", `http://x:${token}@${origin}/acme/missing.git`, "missing")).rejects.toThrow(
      /not found|404/,
    );
  });

  it("clones an empty repo, pushes, and the API sees the commits", async () => {
    const url = `http://x:${token}@${origin}/acme/api.git`;
    await git(work, "clone", "--quiet", url, "api");
    const repo = join(work, "api");

    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "README.md"), "# API\n");
    writeFileSync(join(repo, "src", "index.ts"), "export const answer = 42;\n");
    writeFileSync(join(repo, "logo.bin"), Buffer.from([0, 1, 2, 3]));
    await git(repo, "add", ".");
    await git(repo, "commit", "-q", "-m", "First commit");
    writeFileSync(join(repo, "src", "index.ts"), "export const answer = 43;\n");
    await git(repo, "commit", "-q", "-am", "Change the answer", "-m", "Longer explanation.");
    await git(repo, "push", "-q", "origin", "main");
    await git(repo, "push", "-q", "origin", "main:feature/login");

    const project = await api("GET", "/api/projects/acme/api");
    expect(project.body.project.defaultBranch).toBe("main");
    expect(project.body.branches.map((b: { name: string }) => b.name).sort()).toEqual(["feature/login", "main"]);

    const root = await api("GET", "/api/projects/acme/api/tree?ref=main");
    expect(root.body.entries.map((e: { name: string; type: string }) => `${e.type}:${e.name}`)).toEqual([
      "tree:src",
      "blob:logo.bin",
      "blob:README.md",
    ]);

    const sub = await api("GET", "/api/projects/acme/api/tree?ref=feature/login&path=src");
    expect(sub.body.entries[0]).toMatchObject({ path: "src/index.ts", size: 26 });

    const file = await api("GET", "/api/projects/acme/api/blob?path=src/index.ts");
    expect(file.body.blob.content).toBe("export const answer = 43;\n");
    const bin = await api("GET", "/api/projects/acme/api/blob?path=logo.bin");
    expect(bin.body.blob).toMatchObject({ binary: true, content: null });

    const commits = await api("GET", "/api/projects/acme/api/commits");
    expect(commits.body.commits.map((c: { subject: string }) => c.subject)).toEqual([
      "Change the answer",
      "First commit",
    ]);
    const fileHistory = await api("GET", "/api/projects/acme/api/commits?path=README.md");
    expect(fileHistory.body.commits).toHaveLength(1);

    const latest = commits.body.commits[0];
    const detail = await api("GET", `/api/projects/acme/api/commits/${latest.sha}`);
    expect(detail.body.commit).toMatchObject({ subject: "Change the answer", body: "Longer explanation." });
    expect(detail.body.commit.files).toEqual([
      expect.objectContaining({ newPath: "src/index.ts", status: "modified", additions: 1, deletions: 1 }),
    ]);

    const first = await api("GET", `/api/projects/acme/api/commits/${commits.body.commits[1].sha}`);
    expect(first.body.commit.files.map((f: { newPath: string; status: string }) => `${f.status}:${f.newPath}`).sort()).toEqual([
      "added:README.md",
      "added:logo.bin",
      "added:src/index.ts",
    ]);

    // A second clone sees what was pushed.
    await git(work, "clone", "--quiet", url, "api2");
    expect((await git(join(work, "api2"), "log", "--format=%s")).trim().split("\n")).toEqual([
      "Change the answer",
      "First commit",
    ]);
  });

  it("lists repos with their health", async () => {
    const repos = (await api("GET", "/api/repos")).body.repos as { slug: string; lastCommit: { subject: string } | null; defaultBranch: string | null }[];
    const apiRepo = repos.find((r) => r.slug === "api")!;
    expect(apiRepo).toMatchObject({ defaultBranch: "main", lastCommit: { subject: "Change the answer" }, openIssues: 0, runningJobs: 0, pipeline: null });
  });

  it("adds each file's last commit to the file browser", async () => {
    const res = await api("GET", "/api/projects/acme/api/tree?details=1");
    const byName = Object.fromEntries(res.body.entries.map((e: { name: string; lastCommit: { subject: string } }) => [e.name, e.lastCommit?.subject]));
    expect(byName).toEqual({ src: "Change the answer", "logo.bin": "First commit", "README.md": "First commit" });
  });

  it("searches file names and contents", async () => {
    const res = await api("GET", "/api/projects/acme/api/search?q=ANSWER");
    expect(res.body.lines).toEqual([{ path: "src/index.ts", line: 1, text: "export const answer = 43;" }]);
    expect((await api("GET", "/api/projects/acme/api/search?q=index")).body.files).toEqual(["src/index.ts"]);
    expect((await api("GET", "/api/projects/acme/api/search?q=a")).status).toBe(400);
  });

  it("rejects unsafe refs and paths", async () => {
    expect((await api("GET", "/api/projects/acme/api/tree?ref=--output=/tmp/x")).status).toBe(404);
    expect((await api("GET", "/api/projects/acme/api/tree?path=../../etc")).status).toBe(400);
    expect((await api("GET", "/api/projects/acme/api/commits/not-a-sha")).status).toBe(404);
  });

  it("reports empty repos", async () => {
    await api("POST", "/api/workspaces/acme/projects", { name: "Empty", slug: "empty" });
    const res = await api("GET", "/api/projects/acme/empty/tree");
    expect(res).toEqual({ status: 404, body: { error: "This repository is empty" } });
  });
});

describe("parsePatch", () => {
  it("handles renames, deletes and binary files", () => {
    const files = parsePatch(
      [
        "diff --git a/old.txt b/new.txt",
        "similarity index 100%",
        "rename from old.txt",
        "rename to new.txt",
        "diff --git a/gone.txt b/gone.txt",
        "deleted file mode 100644",
        "index 1234567..0000000",
        "--- a/gone.txt",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-bye",
        "diff --git a/img.png b/img.png",
        "index 1234567..89abcde 100644",
        "Binary files a/img.png and b/img.png differ",
        "",
      ].join("\n"),
    );
    expect(files).toEqual([
      expect.objectContaining({ status: "renamed", oldPath: "old.txt", newPath: "new.txt" }),
      expect.objectContaining({ status: "deleted", oldPath: "gone.txt", newPath: null, deletions: 1 }),
      expect.objectContaining({ status: "modified", binary: true, newPath: "img.png" }),
    ]);
  });
});
