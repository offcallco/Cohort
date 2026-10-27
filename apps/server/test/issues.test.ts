import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, signUp, type App } from "./helpers.ts";

let app: App;
let cleanup: () => Promise<void>;
let cookie: string;

const call = async (method: "GET" | "POST" | "PATCH", url: string, payload?: object) => {
  const res = await app.inject({ method, url, payload, headers: { cookie } });
  return { status: res.statusCode, body: res.json() };
};
const base = "/api/projects/acme/api/issues";
const create = (payload: object) => call("POST", base, payload);
const patch = (n: number, payload: object) => call("PATCH", `${base}/${n}`, payload);
const get = async (n: number) => (await call("GET", `${base}/${n}`)).body.issue;

beforeAll(async () => {
  ({ app, cleanup } = await createTestApp());
  ({ cookie } = await signUp(app));
  await call("POST", "/api/workspaces", { name: "Acme", slug: "acme" });
  await call("POST", "/api/workspaces/acme/projects", { name: "API", slug: "api" });
  await call("POST", "/api/workspaces/acme/projects", { name: "Web", slug: "web" });
});

afterAll(() => cleanup());

describe("issues", () => {
  it("numbers issues per project", async () => {
    const a = await create({ title: "Set up CI", body: "Use **the** runner", labels: ["infra", "infra"] });
    expect(a.status).toBe(201);
    expect(a.body.issue).toMatchObject({
      number: 1,
      status: "todo",
      project: "acme/api",
      author: { username: "justin" },
      labels: [{ name: "infra" }],
    });
    expect((await create({ title: "Login page" })).body.issue.number).toBe(2);
    const other = await call("POST", "/api/projects/acme/web/issues", { title: "Landing page" });
    expect(other.body.issue.number).toBe(1);
  });

  it("validates input", async () => {
    expect((await create({ title: "  " })).status).toBe(400);
    expect((await create({ title: "x", status: "nope" })).status).toBe(400);
    expect((await create({ title: "x", assignee: "ghost" })).body).toEqual({ error: 'Unknown user "ghost"' });
    expect((await create({ title: "x", dependsOn: [99] })).body.error).toMatch(/#99 doesn't exist/);
  });

  it("updates fields and labels", async () => {
    const res = await patch(2, { status: "in_progress", assignee: "justin", labels: ["ui", "auth"], title: "Login form" });
    expect(res.body.issue).toMatchObject({
      title: "Login form",
      status: "in_progress",
      assignee: { username: "justin" },
      labels: [{ name: "auth" }, { name: "ui" }],
    });
    const cleared = await patch(2, { assignee: null, labels: [] });
    expect(cleared.body.issue).toMatchObject({ assignee: null, labels: [], title: "Login form" });

    const labels = await call("GET", "/api/projects/acme/api/labels");
    expect(labels.body.labels.map((l: { name: string }) => l.name)).toEqual(["auth", "infra", "ui"]);
  });

  it("tracks dependencies and rejects cycles", async () => {
    await create({ title: "Schema" }); // #3
    const api = await create({ title: "Endpoints", dependsOn: [3] }); // #4
    expect(api.body.issue).toMatchObject({ waitingOn: 1, dependsOn: [{ number: 3, title: "Schema" }] });
    await create({ title: "UI", dependsOn: [4] }); // #5

    expect((await patch(3, { dependsOn: [5] })).body.error).toBe("That would create a dependency cycle");
    expect((await patch(3, { dependsOn: [3] })).body.error).toBe("An issue can't wait on itself");

    expect((await get(3)).blocks).toEqual([{ number: 4, title: "Endpoints", status: "todo" }]);

    await patch(3, { status: "done" });
    expect((await get(4)).waitingOn).toBe(0);
  });

  it("rejects dependencies on other projects' issues by number", async () => {
    // #1 in acme/web exists, but numbers are looked up in this project only.
    const res = await call("POST", "/api/projects/acme/web/issues", { title: "x", dependsOn: [5] });
    expect(res.body.error).toMatch(/#5 doesn't exist/);
  });

  it("handles parents and children", async () => {
    const parent = await create({ title: "Epic" }); // #6
    const n = parent.body.issue.number;
    await create({ title: "Part A", parent: n });
    await create({ title: "Part B", parent: n });
    const epic = await get(n);
    expect(epic.children).toBe(2);
    expect(epic.childIssues.map((c: { title: string }) => c.title)).toEqual(["Part A", "Part B"]);
    expect((await get(n + 1)).parentIssue).toMatchObject({ number: n, title: "Epic" });

    expect((await patch(n, { parent: n + 1 })).body.error).toMatch(/own parent or ancestor/);
    expect((await patch(n + 1, { parent: null })).body.issue.parentIssue).toBeNull();
  });

  it("adds comments", async () => {
    const res = await call("POST", `${base}/1/comments`, { body: "Looks good" });
    expect(res.status).toBe(201);
    expect(res.body.issue).toMatchObject({
      comments: 1,
      commentList: [{ body: "Looks good", author: { username: "justin" } }],
    });
    expect((await call("POST", `${base}/1/comments`, { body: " " })).status).toBe(400);
  });

  it("filters lists", async () => {
    const titles = async (query: string, url = base) =>
      (await call("GET", `${url}?${query}`)).body.issues.map((i: { title: string }) => i.title).sort();

    expect(await titles("status=done")).toEqual(["Schema"]);
    expect((await titles("status=open")).includes("Schema")).toBe(false);
    expect(await titles("label=infra")).toEqual(["Set up CI"]);
    expect(await titles("q=part")).toEqual(["Part A", "Part B"]);
    expect(await titles("q=100%")).toEqual([]);
    expect(await titles("status=open&q=landing", "/api/workspaces/acme/issues")).toEqual(["Landing page"]);
  });

  it("404s for unknown issues and projects", async () => {
    expect((await call("GET", `${base}/999`)).status).toBe(404);
    expect((await call("GET", `${base}/abc`)).status).toBe(404);
    expect((await call("GET", "/api/projects/acme/nope/issues")).status).toBe(404);
  });
});
