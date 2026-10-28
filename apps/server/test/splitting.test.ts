import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { users } from "@cohort/db";
import type { IssueDetail, Job } from "@cohort/shared";
import { createAdapter } from "../../runner/src/agents/index.ts";
import { RunnerClient } from "../../runner/src/client.ts";
import type { AgentConfig } from "../../runner/src/config.ts";
import { createTestApp, signUp, type App } from "./helpers.ts";

let app: App;
let tmp: string;
let cleanup: () => Promise<void>;
let cookie: string;
let client: RunnerClient;
let orderLog: string;

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

// Each test gets its own project so branches and numbers don't mix.
let projectCount = 0;
async function newProject() {
  const slug = `p${++projectCount}`;
  await call("POST", "/api/workspaces/acme/projects", { name: slug, slug, initReadme: true });
  const api = `/api/projects/acme/${slug}`;
  return {
    api,
    create: async (body: object) => (await call("POST", `${api}/issues`, body)).body.issue as IssueDetail,
    get: async (n: number) => (await call("GET", `${api}/issues/${n}`)).body.issue as IssueDetail,
    patch: (n: number, body: object) => call("PATCH", `${api}/issues/${n}`, body),
    jobs: async (n: number) => (await call("GET", `${api}/issues/${n}/jobs`)).body.jobs as Job[],
    status: async (n: number, status: string) =>
      until(async () => {
        const i = (await call("GET", `${api}/issues/${n}`)).body.issue as IssueDetail;
        return i.status === status ? i : null;
      }, `#${n} to be ${status}`),
    mr: async (n: number) => (await call("GET", `${api}/merge_requests/${n}`)).body.mergeRequest,
    branches: async () => ((await call("GET", api)).body.branches as { name: string }[]).map((b) => b.name).sort(),
  };
}

// Handles split, implement and resolve prompts by what they say. Titles decide the split.
const AGENT_SCRIPT = `
P="$COHORT_PROMPT"
n=$(printf '%s' "$P" | sed -n 's/.*[Ii]ssue #\\([0-9][0-9]*\\).*/\\1/p' | head -1)
parts() {
  printf '<issues>['
  i=0
  for spec in "$@"; do
    key=\${spec%%:*}; deps=\${spec#*:}
    [ $i -gt 0 ] && printf ','
    dep_json=""
    [ -n "$deps" ] && dep_json="\\"$deps\\""
    printf '{"key":"%s","title":"%s %s","body":"Do part %s","dependsOn":[%s]}' "$key" "$PART_PREFIX" "$key" "$key" "$dep_json"
    i=$((i+1))
  done
  printf ']</issues>\\n'
}
case "$P" in
  *"Split this issue only if"*)
    case "$P" in
      *"Big job"*) PART_PREFIX="Big part"; parts a: b:a c:a ;;
      *"Huge job"*) PART_PREFIX="Huge part"; parts a: b: c: d: e: f: ;;
      *"Clash job"*) PART_PREFIX="Clash part"; parts a: b: ;;
      *) echo '<issues>[]</issues>' ;;
    esac ;;
  *"left merge conflicts"*)
    for f in $(git diff --name-only --diff-filter=U); do printf 'resolved\\n' > "$f"; done
    echo "Resolved the conflicts" ;;
  *)
    echo "start $n" >> "$ORDER_LOG"
    sleep 0.3
    case "$P" in
      *"Clash part"*) printf 'part %s\\n' "$n" > shared.txt ;;
      *) printf '%s\\n' "$n" > "issue-$n.txt" ;;
    esac
    echo "end $n" >> "$ORDER_LOG"
    echo "Did #$n" ;;
esac
`;

beforeAll(async () => {
  let db;
  ({ app, tmp, cleanup, db } = await createTestApp({ graceMs: 500 }));
  ({ cookie } = await signUp(app));
  db.insert(users).values({ username: "script-bot", passwordHash: "", kind: "bot", agentType: "command" }).run();
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  await call("POST", "/api/workspaces", { name: "Acme", slug: "acme" });

  orderLog = join(tmp, "order.log");
  writeFileSync(orderLog, "");
  const script = join(tmp, "agent.sh");
  writeFileSync(script, AGENT_SCRIPT);
  const agent: AgentConfig = {
    name: "splitter",
    type: "command",
    command: `ORDER_LOG='${orderLog}' sh '${script}'`,
    limit: 3,
    args: [],
    permission_mode: "acceptEdits",
  };
  const runner = await call("POST", "/api/runners", { name: "split-runner" });
  client = new RunnerClient(
    {
      url: `http://127.0.0.1:${address.port}`,
      token: runner.body.token,
      concurrent: 3,
      agents: [agent],
      context: { instructions: "" },
      split: { max_subtasks: 4, max_depth: 1 },
      dataDir: join(tmp, "runner"),
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

describe("splitting", () => {
  it("splits a big issue, runs the parts in dependency order and opens one MR", async () => {
    const p = await newProject();
    const big = await p.create({ title: "Big job", assignee: "script-bot" });
    const parent = await p.status(big.number, "review");

    expect(parent.branch).toBe(`cohort/${big.number}-big-job`);
    const kids = await Promise.all(parent.childIssues.map((c) => p.get(c.number)));
    expect(kids.map((k) => [k.title, k.origin, k.status, k.assignee?.username])).toEqual([
      ["Big part a", "split", "done", "script-bot"],
      ["Big part b", "split", "done", "script-bot"],
      ["Big part c", "split", "done", "script-bot"],
    ]);
    const [a, b, c] = kids.map((k) => k.number);
    expect(kids[1]!.dependsOn.map((d) => d.number)).toEqual([a]);
    expect(kids[0]!.branch).toBe(`${parent.branch}--${a}-big-part-a`);

    // b and c only started after a was merged.
    const order = readFileSync(orderLog, "utf8").split("\n").filter(Boolean);
    expect(order.indexOf(`end ${a}`)).toBeLessThan(order.indexOf(`start ${b}`));
    expect(order.indexOf(`end ${a}`)).toBeLessThan(order.indexOf(`start ${c}`));

    const jobKinds = (await p.jobs(big.number)).map((j) => j.kind);
    expect(jobKinds).toEqual(["split"]);
    expect(parent.commentList.map((m) => m.body).join("\n")).toContain(`Split into #${a}, #${b}, #${c}`);

    const mr = await p.mr(1);
    expect(mr).toMatchObject({ sourceBranch: parent.branch, targetBranch: "main", mergeable: true, issue: { number: big.number } });
    expect(mr.files.map((f: { newPath: string }) => f.newPath).sort()).toEqual([`issue-${a}.txt`, `issue-${b}.txt`, `issue-${c}.txt`]);
    // Sub-issue branches are gone once merged into the parent's.
    expect(await p.branches()).toEqual([parent.branch, "main"].sort());

    await call("POST", `${p.api}/merge_requests/1/merge`, {});
    expect((await p.get(big.number)).status).toBe("done");
  }, 40_000);

  it("does small issues as one job", async () => {
    const p = await newProject();
    const small = await p.create({ title: "Small job", assignee: "script-bot" });
    const issue = await p.status(small.number, "review");
    expect((await p.jobs(small.number)).map((j) => j.kind)).toEqual(["implement", "split"]);
    expect(issue.childIssues).toEqual([]);
    expect(issue.commentList[0]!.body).toBe("This is small enough to do as one job.");
    expect((await p.mr(1)).files.map((f: { newPath: string }) => f.newPath)).toEqual([`issue-${small.number}.txt`]);
  }, 30_000);

  it("skips splitting for issues labeled no-split", async () => {
    const p = await newProject();
    const issue = await p.create({ title: "Big job", labels: ["no-split"], assignee: "script-bot" });
    await p.status(issue.number, "review");
    expect((await p.jobs(issue.number)).map((j) => j.kind)).toEqual(["implement"]);
  }, 30_000);

  it("waits for approval when a split is over the limit", async () => {
    const p = await newProject();
    const declined = await p.create({ title: "Huge job", assignee: "script-bot" });
    const waiting = await p.status(declined.number, "blocked");
    expect(waiting.splitProposal).toMatchObject({ limit: 4 });
    expect(waiting.splitProposal!.issues).toHaveLength(6);
    expect(waiting.commentList.at(-1)!.body).toContain("more than this runner's limit of 4");

    // Declined: done as one job.
    const res = await call("POST", `${p.api}/issues/${declined.number}/split`, { approve: false });
    expect(res.body.issue.splitProposal).toBeNull();
    const done = await p.status(declined.number, "review");
    expect(done.childIssues).toEqual([]);

    // Approved: all six run, three at a time, then one MR.
    const approved = await p.create({ title: "Huge job", assignee: "script-bot" });
    await p.status(approved.number, "blocked");
    await call("POST", `${p.api}/issues/${approved.number}/split`, { approve: true });
    const parent = await p.status(approved.number, "review");
    expect(parent.childIssues).toHaveLength(6);
    expect((await call("POST", `${p.api}/issues/${approved.number}/split`, { approve: true })).status).toBe(400);
  }, 60_000);

  it("asks the agent to resolve conflicts between parts", async () => {
    const p = await newProject();
    const clash = await p.create({ title: "Clash job", assignee: "script-bot" });
    const parent = await p.status(clash.number, "review");
    const kids = await Promise.all(parent.childIssues.map((c) => p.get(c.number)));
    const kinds = (await Promise.all(kids.map((k) => p.jobs(k.number)))).map((js) => js.map((j) => j.kind).sort());
    // One part merged cleanly; the other needed a resolve job.
    expect(kinds.flat().filter((k) => k === "resolve")).toHaveLength(1);
    const mr = await p.mr(1);
    expect(mr.mergeable).toBe(true);
    const shared = (await call("GET", `${p.api}/blob?ref=${encodeURIComponent(parent.branch!)}&path=shared.txt`)).body.blob.content;
    expect(shared).toBe("resolved\n");
  }, 40_000);
});

describe("dependencies", () => {
  it("holds an issue until the issues it waits on are done", async () => {
    const p = await newProject();
    const first = await p.create({ title: "First" });
    const second = await p.create({ title: "Second", dependsOn: [first.number], assignee: "script-bot" });
    const [job] = await p.jobs(second.number);
    expect(job).toMatchObject({ status: "queued", waitingReason: `Waiting on #${first.number}` });
    await new Promise((r) => setTimeout(r, 300));
    expect((await p.jobs(second.number))[0]!.status).toBe("queued");

    await p.patch(first.number, { status: "done" });
    await p.status(second.number, "review");
  }, 30_000);

  it("runs a plan's sub-issues in order when the plan is assigned", async () => {
    const p = await newProject();
    const plan = await p.create({ title: "Plan: two steps" });
    const one = await p.create({ title: "Step one", parent: plan.number });
    const two = await p.create({ title: "Step two", parent: plan.number, dependsOn: [one.number] });

    await p.patch(plan.number, { assignee: "script-bot" });
    expect((await p.get(two.number)).assignee?.username).toBe("script-bot");
    expect((await p.jobs(plan.number))).toEqual([]);

    // Step one gets its own MR; step two waits until that's merged.
    await p.status(one.number, "review");
    expect((await p.jobs(two.number))[0]).toMatchObject({ status: "queued", waitingReason: `Waiting on #${one.number}` });
    await call("POST", `${p.api}/merge_requests/1/merge`, {});
    await p.status(two.number, "review");
    await call("POST", `${p.api}/merge_requests/2/merge`, {});
    await p.status(plan.number, "done");
  }, 40_000);
});
