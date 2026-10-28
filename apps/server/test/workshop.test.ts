import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { users } from "@cohort/db";
import type { WorkshopDetail } from "@cohort/shared";
import { createAdapter } from "../../runner/src/agents/index.ts";
import { RunnerClient } from "../../runner/src/client.ts";
import type { AgentConfig } from "../../runner/src/config.ts";
import type { AgentAdapter } from "../../runner/src/agents/index.ts";
import { orderIssues, parseReply } from "../src/workshops/parse.ts";
import { createTestApp, signUp, type App } from "./helpers.ts";

let app: App;
let tmp: string;
let cleanup: () => Promise<void>;
let cookie: string;
let client: RunnerClient;
let promptLog: string;
let runnerDir: string;
let serverUrl: string;

const call = async (method: "GET" | "POST", url: string, payload?: object) => {
  const res = await app.inject({ method, url, payload, headers: { cookie } });
  return { status: res.statusCode, body: res.json() };
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

const base = "/api/projects/acme/app/workshops";
const getWorkshop = async (id: number): Promise<WorkshopDetail> => (await call("GET", `${base}/${id}`)).body.workshop;
const settled = (id: number) =>
  until(async () => {
    const w = await getWorkshop(id);
    return w.waiting ? null : w;
  }, "the agent's turn");

// A scripted interviewer: logs each prompt, asks numbered questions, and proposes two issues
// when asked to finalize.
const interviewer = (log: string): AgentConfig => ({
  name: "interviewer",
  type: "command",
  limit: 2,
  args: [],
  permission_mode: "acceptEdits",
  command: [
    `printf '%s\\n=====\\n' "$COHORT_PROMPT" >> '${log}'`,
    `test -f README.md || { echo "not in a checkout" >&2; exit 1; }`,
    `if printf '%s' "$COHORT_PROMPT" | grep -q "ready to cut issues"; then`,
    `  printf '%s\\n' '<message>Two issues: schema first, then the API.</message>' '<plan># Final plan' 'Build it in two steps.</plan>' '<issues>' '\`\`\`json'`,
    `  printf '%s\\n' '[{"key":"schema","title":"Add the schema","body":"Tables for X","labels":["db"],"dependsOn":[]},'`,
    `  printf '%s\\n' ' {"key":"api","title":"Add the API","body":"Routes for X","labels":["api"],"dependsOn":["schema"]}]'`,
    `  printf '%s\\n' '\`\`\`' '</issues>'`,
    `else`,
    `  turn=$(grep -c '^=====$' '${log}')`,
    `  printf '<message>Question %s: who uses this?</message>\\n<plan># Draft %s</plan>\\n' "$turn" "$turn"`,
    `fi`,
  ].join("\n"),
});

beforeAll(async () => {
  let db;
  ({ app, tmp, cleanup, db } = await createTestApp({ graceMs: 500 }));
  ({ cookie } = await signUp(app));
  db.insert(users).values({ username: "script-bot", passwordHash: "", kind: "bot", agentType: "command" }).run();
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("no port");

  await call("POST", "/api/workspaces", { name: "Acme", slug: "acme" });
  await call("POST", "/api/workspaces/acme/projects", { name: "App", slug: "app", initReadme: true });

  serverUrl = `http://127.0.0.1:${address.port}`;
  promptLog = join(tmp, "prompts.log");
  runnerDir = join(tmp, "runner");
  const agent = interviewer(promptLog);
  const runner = await call("POST", "/api/runners", { name: "workshop-runner" });
  client = new RunnerClient(
    {
      url: `http://127.0.0.1:${address.port}`,
      token: runner.body.token,
      concurrent: 2,
      agents: [agent],
      context: { instructions: "" },
      dataDir: runnerDir,
    },
    [createAdapter(agent)],
    { info: () => {}, error: () => {} },
  );
  client.start();
  await until(async () => (await call("GET", "/api/runners")).body.runners[0]?.online, "runner to connect");
}, 30_000);

afterAll(async () => {
  await client.stop();
  await cleanup();
});

describe("plan workshops", () => {
  let id: number;

  it("starts with the idea and gets the agent's first question", async () => {
    const res = await call("POST", base, { idea: "Add team invites\nso people can join a workspace", bot: "script-bot" });
    expect(res.status).toBe(201);
    id = res.body.workshop.id;
    expect(res.body.workshop).toMatchObject({ title: "Add team invites", status: "active", waiting: true, bot: "script-bot" });

    const w = await settled(id);
    expect(w.messageList.map((m) => [m.role, m.body])).toEqual([
      ["user", "Add team invites\nso people can join a workspace"],
      ["agent", "Question 1: who uses this?"],
    ]);
    expect(w.plan).toBe("# Draft 1");
    expect(w.job).toMatchObject({ kind: "workshop", status: "succeeded", workshop: id });

    const prompt = readFileSync(promptLog, "utf8");
    expect(prompt).toContain("plan workshop in Cohort for the project acme/app");
    expect(prompt).toContain("Ask exactly one question per reply");
    expect(prompt).toContain("The user's idea:\n\nAdd team invites");
    expect(existsSync(join(runnerDir, "workshops", `w-${id}`, "README.md"))).toBe(true);
  });

  it("continues with the transcript when the agent can't resume a session", async () => {
    const res = await call("POST", `${base}/${id}/messages`, { body: "Workspace admins" });
    expect(res.status).toBe(201);
    expect((await call("POST", `${base}/${id}/messages`, { body: "too fast" })).status).toBe(409);

    const w = await settled(id);
    expect(w.messageList.at(-1)).toMatchObject({ role: "agent", body: "Question 2: who uses this?" });
    expect(w.plan).toBe("# Draft 2");
    const second = readFileSync(promptLog, "utf8").split("=====").at(-2)!;
    expect(second).toContain("The conversation so far:");
    expect(second).toContain("User: Add team invites");
    expect(second).toContain("You: Question 1: who uses this?");
    expect(second).toContain("The plan so far:\n\n# Draft 1");
    expect(second).toContain("The user replied:\n\nWorkspace admins");
  });

  it("proposes issues and turns them into linked issues", async () => {
    await call("POST", `${base}/${id}/propose`);
    const w = await settled(id);
    expect(w.plan).toBe("# Final plan\nBuild it in two steps.");
    expect(w.proposal).toEqual([
      { key: "schema", title: "Add the schema", body: "Tables for X", labels: ["db"], dependsOn: [] },
      { key: "api", title: "Add the API", body: "Routes for X", labels: ["api"], dependsOn: ["schema"] },
    ]);

    // The user edits one before creating them.
    const edited = [{ ...w.proposal![0]!, title: "Add the invites table" }, w.proposal![1]!];
    const res = await call("POST", `${base}/${id}/issues`, { issues: edited, parentIssue: true });
    expect(res.status).toBe(201);
    expect(res.body.workshop).toMatchObject({ status: "done", parentIssue: { title: "Plan: Add team invites" } });
    expect(res.body.workshop.createdIssues.map((i: { title: string }) => i.title)).toEqual(["Add the invites table", "Add the API"]);

    const [parent, schema, api] = [res.body.created.parent, ...res.body.created.numbers];
    const apiIssue = (await call("GET", `/api/projects/acme/app/issues/${api}`)).body.issue;
    expect(apiIssue).toMatchObject({ parentIssue: { number: parent }, dependsOn: [{ number: schema }], labels: [{ name: "api" }] });
    expect(apiIssue.body).toContain(`From workshop #${id}`);
    const parentIssue = (await call("GET", `/api/projects/acme/app/issues/${parent}`)).body.issue;
    expect(parentIssue.body).toContain("Build it in two steps.");
    expect(parentIssue.dependsOn.map((d: { number: number }) => d.number)).toEqual([schema, api]);

    expect((await call("POST", `${base}/${id}/messages`, { body: "more" })).status).toBe(409);
    // The runner removes the workshop's checkout once it's done.
    await until(async () => !existsSync(join(runnerDir, "workshops", `w-${id}`)), "checkout cleanup");
  });

  it("rejects broken issue lists", async () => {
    const w = (await call("POST", base, { idea: "Another idea", bot: "script-bot" })).body.workshop;
    await settled(w.id);
    const loop = [
      { key: "a", title: "A", dependsOn: ["b"] },
      { key: "b", title: "B", dependsOn: ["a"] },
    ];
    expect((await call("POST", `${base}/${w.id}/issues`, { issues: loop })).body.error).toMatch(/loop back/);
    const unknown = [{ key: "a", title: "A", dependsOn: ["zzz"] }];
    expect((await call("POST", `${base}/${w.id}/issues`, { issues: unknown })).body.error).toMatch(/isn't in the list/);

    const closed = await call("POST", `${base}/${w.id}/close`);
    expect(closed.body.workshop.status).toBe("closed");
  });

  it("queues when no runner has the agent and says so", async () => {
    const res = await call("POST", base, { idea: "Needs codex", bot: "codex-bot" });
    expect(res.body.workshop.job).toMatchObject({ status: "queued", waitingReason: "No runner with codex is online" });
    const listed = (await call("GET", base)).body.workshops.find((w: { title: string }) => w.title === "Needs codex");
    expect(listed).toMatchObject({ waiting: true });
  });

  it("validates new workshops", async () => {
    expect((await call("POST", base, { idea: "x", bot: "justin" })).body.error).toBe('"justin" isn\'t an agent');
    await call("POST", "/api/workspaces/acme/projects", { name: "Empty", slug: "empty" });
    const empty = await call("POST", "/api/projects/acme/empty/workshops", { idea: "x", bot: "claude-bot" });
    expect(empty).toEqual({ status: 409, body: { error: "Push at least one commit first, so the agent has code to read" } });
  });
});

describe("session resume", () => {
  it("resumes the agent's session on the runner that holds it", async () => {
    // Replace the scripted runner with one whose agent can resume sessions.
    await client.stop();
    const resumes: (string | null)[] = [];
    const resumable: AgentAdapter = {
      name: "resumer",
      type: "command",
      resumable: true,
      available: async () => true,
      implement: async () => ({ summary: "" }),
      plan: async ({ resume }) => {
        resumes.push(resume);
        return { text: `<message>Turn ${resumes.length}</message>`, sessionId: "session-1" };
      },
    };
    const runner = await call("POST", "/api/runners", { name: "resume-runner" });
    client = new RunnerClient(
      { url: serverUrl, token: runner.body.token, concurrent: 1, agents: [], context: { instructions: "" }, dataDir: join(tmp, "resume-runner") },
      [resumable],
      { info: () => {}, error: () => {} },
    );
    client.start();
    await until(
      async () => (await call("GET", "/api/runners")).body.runners.find((r: { name: string; online: boolean }) => r.name === "resume-runner" && r.online),
      "resume runner",
    );

    const w = (await call("POST", base, { idea: "Resume me", bot: "script-bot" })).body.workshop;
    await settled(w.id);
    await call("POST", `${base}/${w.id}/messages`, { body: "Next" });
    const done = await settled(w.id);
    expect(done.messageList.at(-1)!.body).toBe("Turn 2");
    expect(resumes).toEqual([null, "session-1"]);
  });
});

describe("parseReply", () => {
  it("reads all three sections", () => {
    const reply = parseReply('Thinking...\n<message>Hi</message>\n<plan># P</plan>\n<issues>[{"key":"a","title":"A"}]</issues>');
    expect(reply).toEqual({
      message: "Hi",
      plan: "# P",
      issues: [{ key: "a", title: "A", body: "", labels: [], dependsOn: [] }],
      issuesError: null,
    });
  });

  it("copes with missing tags", () => {
    // Seen from Claude: the <plan> tag left out.
    expect(parseReply("<message>Only a question?</message>")).toMatchObject({ message: "Only a question?", plan: null });
    expect(parseReply("No tags at all")).toMatchObject({ message: "No tags at all", plan: null });
    expect(parseReply("Hello <plan># P</plan>")).toMatchObject({ message: "Hello", plan: "# P" });
    expect(parseReply("<message>Cut off")).toMatchObject({ message: "Cut off" });
  });

  it("reports unreadable issue lists", () => {
    expect(parseReply("<message>x</message><issues>not json</issues>").issuesError).toBe("The issue list wasn't valid JSON");
    expect(parseReply('<message>x</message><issues>[{"key":"a"}]</issues>').issuesError).toBeTruthy();
  });
});

describe("orderIssues", () => {
  it("puts dependencies first", () => {
    const list = [
      { key: "c", title: "C", body: "", labels: [], dependsOn: ["b"] },
      { key: "b", title: "B", body: "", labels: [], dependsOn: ["a"] },
      { key: "a", title: "A", body: "", labels: [], dependsOn: [] },
    ];
    expect(orderIssues(list).map((i) => i.key)).toEqual(["a", "b", "c"]);
  });

  it("rejects duplicate keys and self-dependencies", () => {
    expect(() => orderIssues([{ key: "a", title: "A", body: "", labels: [], dependsOn: ["a"] }])).toThrow(/itself/);
    expect(() =>
      orderIssues([
        { key: "a", title: "A", body: "", labels: [], dependsOn: [] },
        { key: "a", title: "B", body: "", labels: [], dependsOn: [] },
      ]),
    ).toThrow(/Two issues/);
  });
});
