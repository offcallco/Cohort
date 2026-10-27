import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { accessTokens, sessions, users, type Db } from "@cohort/db";
import type { User } from "@cohort/shared";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEY_LENGTH = 64;
export const SESSION_COOKIE = "cohort_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_PREFIX = "cohort_";

// Stored as "scrypt$<salt>$<hash>", both base64.
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scryptAsync(password, Buffer.from(salt, "base64"), expected.length);
  return timingSafeEqual(actual, expected);
}

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export const randomToken = () => randomBytes(32).toString("base64url");

export function createSession(db: Db, userId: number): { token: string; expiresAt: Date } {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  db.insert(sessions).values({ tokenHash: sha256(token), userId, expiresAt }).run();
  return { token, expiresAt };
}

export function deleteSession(db: Db, token: string) {
  db.delete(sessions).where(eq(sessions.tokenHash, sha256(token))).run();
}

export function userForSession(db: Db, token: string): User | null {
  const row = db
    .select({ id: users.id, username: users.username, kind: users.kind, expiresAt: sessions.expiresAt })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, sha256(token)))
    .get();
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) {
    deleteSession(db, token);
    return null;
  }
  return { id: row.id, username: row.username, kind: row.kind };
}

export function createAccessToken(db: Db, userId: number, name: string) {
  const token = TOKEN_PREFIX + randomToken();
  const row = db
    .insert(accessTokens)
    .values({ userId, name, tokenHash: sha256(token), prefix: token.slice(0, 12) })
    .returning()
    .get();
  return { row, token };
}

export function userForAccessToken(db: Db, token: string): User | null {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const row = db
    .select({ id: users.id, username: users.username, kind: users.kind, tokenId: accessTokens.id })
    .from(accessTokens)
    .innerJoin(users, eq(users.id, accessTokens.userId))
    .where(eq(accessTokens.tokenHash, sha256(token)))
    .get();
  if (!row) return null;
  db.update(accessTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(accessTokens.id, row.tokenId))
    .run();
  return { id: row.id, username: row.username, kind: row.kind };
}
