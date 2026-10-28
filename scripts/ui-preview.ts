// Screenshots Cohort's UI against a throwaway server filled with demo data.
//
//   pnpm ui:preview                    every page, 1440px and 375px, light and dark
//   pnpm ui:preview / /work            only these paths
//   pnpm ui:preview --out shots        where to write the PNGs (default: ./ui-preview)
//   pnpm ui:preview --serve            keep the server running to look at it yourself
//
// Uses the Chrome installed on this machine (set CHROME_PATH to override).

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import { eq } from "drizzle-orm";
import { issueComments, issues as issuesTable, jobs, mergeRequests, pipelineJobs, pipelines, workshopMessages, workshops, users, type Db } from "@cohort/db";
import { openDb } from "@cohort/db";
import { buildApp } from "../apps/server/src/app.ts";

const run = promisify(execFile);
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outDir = resolve(outIndex === -1 ? "ui-preview" : args[outIndex + 1]!);
const serve = args.includes("--serve");
const paths = args.filter((a, i) => a.startsWith("/") && args[i - 1] !== "--out");

const chromePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const webDist = resolve("apps/web/dist");

const tmp = mkdtempSync(join(tmpdir(), "cohort-preview-"));
const { db, close } = openDb(":memory:");
const app = await buildApp({
  db,
  reposRoot: join(tmp, "repos"),
  logsDir: join(tmp, "logs"),
  webDist,
  // Demo jobs marked running have no runner; don't fail them while we look.
  hub: { graceMs: 24 * 3600_000 },
});
await app.listen({ host: "127.0.0.1", port: Number(process.env.PREVIEW_PORT ?? 0) });
const address = app.server.address();
if (!address || typeof address === "string") throw new Error("no port");
const origin = `http://localhost:${address.port}`;

// --- Demo data ----------------------------------------------------------------------------

const setup = await app.inject({ method: "POST", url: "/api/setup", payload: { username: "justin", password: "preview-password" } });
const session = setup.cookies.find((c) => c.name === "cohort_session")!.value;
const call = async (method: string, url: string, payload?: object) => {
  const res = await app.inject({ method: method as "GET", url, payload, headers: { cookie: `cohort_session=${session}` } });
  if (res.statusCode >= 400) throw new Error(`${method} ${url}: ${res.body}`);
  return res.json();
};
const token = (await call("POST", "/api/tokens", { name: "preview" })).token.token as string;

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "justin",
  GIT_AUTHOR_EMAIL: "justin@cohort.local",
  GIT_COMMITTER_NAME: "justin",
  GIT_COMMITTER_EMAIL: "justin@cohort.local",
};
const git = (cwd: string, ...a: string[]) => run("git", ["-c", "init.defaultBranch=main", ...a], { cwd, env: gitEnv });

async function seed(db: Db) {
  await call("POST", "/api/workspaces", { name: "Acme", slug: "acme", description: "Payments and the customer site" });
  await call("POST", "/api/workspaces/acme/projects", { name: "API", slug: "api", description: "Payments API" });
  await call("POST", "/api/workspaces/acme/projects", { name: "Web", slug: "web", description: "Customer site", initReadme: true });
  await call("POST", "/api/workspaces", { name: "Internal", slug: "internal" });
  await call("POST", "/api/workspaces/internal/projects", { name: "Tools", slug: "tools", initReadme: true });

  // Real code in acme/api, plus an agent branch with changes for the merge request.
  const work = join(tmp, "work");
  mkdirSync(join(work, "src"), { recursive: true });
  const files: Record<string, string> = {
    "README.md": "# Payments API\n\nHandles checkout, refunds and payouts.\n\n## Running\n\n```sh\nnpm install\nnpm test\n```\n",
    "package.json": '{ "name": "payments-api", "type": "module", "scripts": { "test": "node --test" } }\n',
    "src/checkout.js": "export function total(items) {\n  return items.reduce((sum, i) => sum + i.price * i.qty, 0);\n}\n",
    "src/refunds.js": "export function refund(order, amount) {\n  if (amount > order.total) throw new Error(\"too much\");\n  return { ...order, refunded: amount };\n}\n",
    ".cohort-ci.yml": "test:\n  script: npm test\nlint:\n  script: echo lint ok\n",
  };
  for (const [path, content] of Object.entries(files)) writeFileSync(join(work, path), content);
  const url = `http://x:${token}@127.0.0.1:${(app.server.address() as { port: number }).port}/acme/api.git`;
  await git(work, "init", "-q");
  await git(work, "add", "-A");
  await git(work, "commit", "-qm", "Initial payments API");
  await git(work, "push", "-q", url, "HEAD:refs/heads/main");
  await git(work, "checkout", "-qb", "cohort/2-refactor-checkout");
  writeFileSync(
    join(work, "src/checkout.js"),
    "// Totals are computed in cents to avoid rounding errors.\nexport function total(items) {\n  return items.reduce((sum, item) => sum + Math.round(item.price * 100) * item.qty, 0) / 100;\n}\n\nexport function tax(amount, rate) {\n  return Math.round(amount * rate * 100) / 100;\n}\n",
  );
  writeFileSync(join(work, "src/checkout.test.js"), "import { test } from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { total } from \"./checkout.js\";\n\ntest(\"total\", () => assert.equal(total([{ price: 0.1, qty: 3 }]), 0.3));\n");
  await git(work, "add", "-A");
  await run("git", ["commit", "-qm", "Refactor checkout totals to cents (#2)"], {
    cwd: work,
    env: { ...gitEnv, GIT_AUTHOR_NAME: "claude-bot", GIT_AUTHOR_EMAIL: "claude-bot@bots.cohort.local" },
  });
  await git(work, "push", "-q", url, "HEAD:refs/heads/cohort/2-refactor-checkout");

  const issues = "/api/projects/acme/api/issues";
  const i1 = (await call("POST", issues, { title: "Add login rate limiting", body: "Limit failed logins to 5 per minute per IP.", labels: ["security"] })).issue;
  const i2 = (await call("POST", issues, { title: "Refactor checkout totals", body: "Compute totals in cents.", labels: ["checkout"] })).issue;
  const i3 = (await call("POST", issues, { title: "Fix flaky refund test", labels: ["tests"] })).issue;
  await call("POST", issues, { title: "Add CSV export for payouts", labels: ["payouts"] });
  const i5 = (await call("POST", issues, { title: "Document the refund API", labels: ["docs"] })).issue;
  await call("POST", "/api/projects/acme/web/issues", { title: "New pricing page", labels: ["marketing"] });
  await call("POST", "/api/projects/internal/tools/issues", { title: "Nightly backup script", assignee: "justin" });

  const bot = db.select().from(users).all().find((u) => u.username === "claude-bot")!;
  const minutes = (n: number) => new Date(Date.now() - n * 60_000);
  const set = (id: number, status: "in_progress" | "review" | "blocked" | "done") =>
    db.update(issuesTable).set({ status, assigneeId: bot.id }).where(eq(issuesTable.id, id)).run();
  set(i1.id, "in_progress");
  set(i2.id, "review");
  set(i3.id, "blocked");
  set(i5.id, "done");

  const job = (values: Partial<typeof jobs.$inferInsert>) =>
    db.insert(jobs).values({ projectId: 1, kind: "implement", botId: bot.id, agentType: "claude-code", branch: "", baseBranch: "main", ...values } as typeof jobs.$inferInsert).returning().get();
  const running = job({ issueId: i1.id, status: "running", branch: "cohort/1-add-login-rate-limiting", startedAt: minutes(6) });
  app.jobs.logs.append(running.id, "Claude Code started\n→ Read src/checkout.js\n→ Edit src/auth/rateLimit.js\n→ Write src/auth/rateLimit.test.js\n");
  const mr = db
    .insert(mergeRequests)
    .values({
      projectId: 1,
      number: 1,
      title: 'Resolve "Refactor checkout totals"',
      description: "Closes #2\n\nTotals are now computed in cents, so `0.1 × 3` is `0.3` instead of `0.30000000000000004`. Added a `tax()` helper and a test for totals.\n\nI wasn't sure whether tax should round half-up or half-even; I used half-up.",
      sourceBranch: "cohort/2-refactor-checkout",
      targetBranch: "main",
      issueId: i2.id,
      authorId: bot.id,
      updatedAt: minutes(20),
    })
    .returning()
    .get();
  job({ issueId: i2.id, status: "succeeded", branch: "cohort/2-refactor-checkout", mergeRequestId: mr.id, startedAt: minutes(40), finishedAt: minutes(22), summary: "Moved totals to cents and added tax()." });
  job({ issueId: i3.id, status: "failed", branch: "cohort/3-fix-flaky-refund-test", startedAt: minutes(90), finishedAt: minutes(75), error: "The agent finished without changing any files" });
  job({ issueId: i5.id, status: "succeeded", branch: "cohort/5-document-the-refund-api", startedAt: minutes(300), finishedAt: minutes(280) });
  db.insert(issueComments).values({ issueId: i2.id, authorId: bot.id, body: "Opened !1 from `cohort/2-refactor-checkout`." }).run();

  // Pushing the demo repo started real pipelines that no runner will pick up; replace them with
  // the states the preview should show.
  // They're created just after each push returns, so wait for both (main and the branch).
  for (let i = 0; i < 100 && db.select().from(pipelines).all().length < 2; i++) await new Promise((r) => setTimeout(r, 50));
  db.delete(pipelineJobs).run();
  db.delete(pipelines).run();
  const mainSha = (await git(work, "rev-parse", "main")).stdout.trim();
  const mainPipeline = db.insert(pipelines).values({ projectId: 1, ref: "main", sha: mainSha, status: "success", source: "push", triggeredById: 1, startedAt: minutes(400), finishedAt: minutes(398) }).returning().get();
  db.insert(pipelineJobs).values([
    { pipelineId: mainPipeline.id, name: "test", stage: "test", stageIndex: 1, script: '["npm test"]', status: "success" },
    { pipelineId: mainPipeline.id, name: "lint", stage: "test", stageIndex: 1, script: '["echo lint ok"]', status: "success" },
  ]).run();
  const head = (await git(work, "rev-parse", "HEAD")).stdout.trim();
  const p = db.insert(pipelines).values({ projectId: 1, ref: "cohort/2-refactor-checkout", sha: head, status: "manual", source: "merge_request", triggeredById: bot.id, mergeRequestId: mr.id }).returning().get();
  db.insert(pipelineJobs).values([
    { pipelineId: p.id, name: "test", stage: "test", stageIndex: 1, script: '["npm test"]' },
    { pipelineId: p.id, name: "lint", stage: "test", stageIndex: 1, script: '["echo lint ok"]' },
  ]).run();

  const w = db
    .insert(workshops)
    .values({ projectId: 1, title: "Payout scheduling", botId: bot.id, baseBranch: "main", createdById: 1, plan: "# Payout scheduling\n\n## Goal\nLet merchants choose daily or weekly payouts.\n\n## Decisions\n- Weekly payouts run on Mondays." })
    .returning()
    .get();
  db.insert(workshopMessages).values([
    { workshopId: w.id, role: "user", body: "Let merchants pick when they get paid out." },
    { workshopId: w.id, role: "agent", body: "**Question: which schedules?** I recommend daily and weekly only; monthly adds month-end edge cases." },
  ]).run();
}

await seed(db);

// --- Screenshots --------------------------------------------------------------------------

const pages = paths.length
  ? paths
  : ["/", "/work", "/reviews", "/agents", "/acme/api", "/acme/api/issues/2", "/acme/api/merge_requests/1", "/acme/api/workshops/1", "/settings/runners"];
const widths = [1440, 375];
const schemes = ["dark", "light"] as const;

if (serve) {
  console.log(`Demo server: ${origin} (sign in as justin / preview-password). Ctrl-C to stop.`);
} else {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ executablePath: chromePath, headless: true });
  for (const scheme of schemes) {
    for (const width of widths) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, deviceScaleFactor: 1 });
      await context.addCookies([{ name: "cohort_session", value: session, url: origin }]);
      const page = await context.newPage();
      for (const path of pages) {
        await page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
        await page.waitForTimeout(300);
        const name = `${path === "/" ? "home" : path.slice(1).replace(/\//g, "_")}-${width}-${scheme}.png`;
        await page.screenshot({ path: join(outDir, name), fullPage: true });
      }
      await context.close();
    }
  }
  await browser.close();
  console.log(`Wrote ${pages.length * widths.length * schemes.length} screenshots to ${outDir}`);
  await app.close();
  close();
  rmSync(tmp, { recursive: true, force: true });
}
