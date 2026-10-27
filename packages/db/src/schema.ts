import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`);

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: createdAt(),
});

// Browser sessions. The cookie holds a random token; only its hash is stored.
export const sessions = sqliteTable("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
});

// Personal access tokens for the API and for git over HTTPS.
export const accessTokens = sqliteTable("access_tokens", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  // First characters of the token, shown in the UI so tokens can be told apart.
  prefix: text("prefix").notNull(),
  createdAt: createdAt(),
  lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
});

export const workspaces = sqliteTable("workspaces", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  createdAt: createdAt(),
});

// A project is one git repo, stored at <repos>/<workspace slug>/<project slug>.git.
export const projects = sqliteTable(
  "projects",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("projects_workspace_slug").on(t.workspaceId, t.slug)],
);
