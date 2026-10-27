import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "@cohort/db";
import { buildApp } from "../src/app.ts";

export type App = Awaited<ReturnType<typeof buildApp>>;

// A fresh app with an in-memory database and a temporary repos folder.
export async function createTestApp() {
  const { db, close } = openDb(":memory:");
  const tmp = mkdtempSync(join(tmpdir(), "cohort-test-"));
  const reposRoot = join(tmp, "repos");
  const app = await buildApp({ db, reposRoot });
  return {
    app,
    tmp,
    reposRoot,
    async cleanup() {
      await app.close();
      close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

export const creds = { username: "justin", password: "correct horse" };

// Creates the account and returns a session cookie header.
export async function signUp(app: App) {
  const res = await app.inject({ method: "POST", url: "/api/setup", payload: creds });
  const cookie = res.cookies.find((c) => c.name === "cohort_session");
  if (res.statusCode !== 201 || !cookie) throw new Error(`setup failed: ${res.body}`);
  return { cookie: `cohort_session=${cookie.value}`, setCookie: cookie };
}
