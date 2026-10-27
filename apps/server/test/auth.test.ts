import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "@cohort/db";
import { buildApp } from "../src/app.ts";

type App = Awaited<ReturnType<typeof buildApp>>;

let app: App;
let close: () => void;

beforeEach(async () => {
  const opened = openDb(":memory:");
  close = opened.close;
  app = await buildApp({ db: opened.db });
});

afterEach(async () => {
  await app.close();
  close();
});

const creds = { username: "justin", password: "correct horse" };

async function setup() {
  const res = await app.inject({ method: "POST", url: "/api/setup", payload: creds });
  expect(res.statusCode).toBe(201);
  const cookie = res.cookies.find((c) => c.name === "cohort_session");
  expect(cookie?.httpOnly).toBe(true);
  return { cookie: `cohort_session=${cookie!.value}` };
}

describe("setup and sessions", () => {
  it("reports setup required until an account exists", async () => {
    const before = await app.inject({ url: "/api/status" });
    expect(before.json()).toMatchObject({ setupRequired: true, user: null });

    const { cookie } = await setup();
    const after = await app.inject({ url: "/api/status", headers: { cookie } });
    expect(after.json()).toMatchObject({ setupRequired: false, user: { username: "justin" } });
  });

  it("refuses a second setup", async () => {
    await setup();
    const res = await app.inject({ method: "POST", url: "/api/setup", payload: creds });
    expect(res.statusCode).toBe(409);
  });

  it("validates credentials", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { username: "justin", password: "short" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/at least 8/);
  });

  it("logs in with the right password only", async () => {
    await setup();
    const wrong = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { ...creds, password: "wrong password" },
    });
    expect(wrong.statusCode).toBe(401);

    const right = await app.inject({ method: "POST", url: "/api/login", payload: creds });
    expect(right.statusCode).toBe(200);
    expect(right.cookies.some((c) => c.name === "cohort_session")).toBe(true);
  });

  it("ends the session on logout", async () => {
    const { cookie } = await setup();
    await app.inject({ method: "POST", url: "/api/logout", headers: { cookie } });
    const me = await app.inject({ url: "/api/me", headers: { cookie } });
    expect(me.statusCode).toBe(401);
  });

  it("rejects unknown hostnames", async () => {
    const res = await app.inject({ url: "/api/status", headers: { host: "evil.example:7700" } });
    expect(res.statusCode).toBe(403);
  });
});

describe("access tokens", () => {
  it("creates, authenticates with, lists and revokes a token", async () => {
    const { cookie } = await setup();

    const created = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: { cookie },
      payload: { name: "laptop git" },
    });
    expect(created.statusCode).toBe(201);
    const { token } = created.json().token as { token: string };
    expect(token).toMatch(/^cohort_/);

    const authorization = `Bearer ${token}`;
    const me = await app.inject({ url: "/api/me", headers: { authorization } });
    expect(me.json().user.username).toBe("justin");

    const list = await app.inject({ url: "/api/tokens", headers: { cookie } });
    const [listed] = list.json().tokens;
    expect(listed).toMatchObject({ name: "laptop git", prefix: token.slice(0, 12) });
    expect(listed.lastUsedAt).not.toBeNull();
    expect(listed).not.toHaveProperty("token");

    const del = await app.inject({
      method: "DELETE",
      url: `/api/tokens/${listed.id}`,
      headers: { cookie },
    });
    expect(del.statusCode).toBe(204);
    const after = await app.inject({ url: "/api/me", headers: { authorization } });
    expect(after.statusCode).toBe(401);
  });

  it("requires sign-in", async () => {
    const res = await app.inject({ url: "/api/tokens" });
    expect(res.statusCode).toBe(401);
  });
});
