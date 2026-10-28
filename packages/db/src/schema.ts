import { sql } from "drizzle-orm";
import {
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`);

export const AGENT_TYPES = ["claude-code", "codex", "command"] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  // Empty for bots, which can't sign in.
  passwordHash: text("password_hash").notNull(),
  // Bots are coding agents: assigning an issue to one starts a job.
  kind: text("kind", { enum: ["human", "bot"] }).notNull().default("human"),
  agentType: text("agent_type", { enum: AGENT_TYPES }),
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
    // Extra instructions included in every agent job for this project.
    runnerContext: text("runner_context").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("projects_workspace_slug").on(t.workspaceId, t.slug)],
);

export const ISSUE_STATUSES = ["todo", "in_progress", "review", "done", "blocked"] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

const updatedAt = () =>
  integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`);

export const issues = sqliteTable(
  "issues",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // Per-project number shown as #1, #2, ...
    number: integer("number").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    status: text("status", { enum: ISSUE_STATUSES }).notNull().default("todo"),
    parentId: integer("parent_id").references((): AnySQLiteColumn => issues.id, { onDelete: "set null" }),
    assigneeId: integer("assignee_id").references(() => users.id, { onDelete: "set null" }),
    authorId: integer("author_id")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("issues_project_number").on(t.projectId, t.number)],
);

// "issueId waits on dependsOnId": the dependency should be done first.
export const issueDependencies = sqliteTable(
  "issue_dependencies",
  {
    issueId: integer("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    dependsOnId: integer("depends_on_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.issueId, t.dependsOnId] })],
);

export const labels = sqliteTable(
  "labels",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull(),
  },
  (t) => [uniqueIndex("labels_project_name").on(t.projectId, t.name)],
);

export const issueLabels = sqliteTable(
  "issue_labels",
  {
    issueId: integer("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    labelId: integer("label_id")
      .notNull()
      .references(() => labels.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.issueId, t.labelId] })],
);

export const issueComments = sqliteTable("issue_comments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  issueId: integer("issue_id")
    .notNull()
    .references(() => issues.id, { onDelete: "cascade" }),
  authorId: integer("author_id")
    .notNull()
    .references(() => users.id),
  body: text("body").notNull(),
  createdAt: createdAt(),
});

export const runners = sqliteTable("runners", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  prefix: text("prefix").notNull(),
  createdAt: createdAt(),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
});

export const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "canceled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const jobs = sqliteTable("jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  issueId: integer("issue_id").references(() => issues.id, { onDelete: "set null" }),
  kind: text("kind", { enum: ["implement", "workshop"] }).notNull(),
  workshopId: integer("workshop_id").references((): AnySQLiteColumn => workshops.id, { onDelete: "cascade" }),
  // Workshop jobs: a normal interview turn, or the final turn that proposes issues.
  workshopMode: text("workshop_mode", { enum: ["turn", "finalize"] }),
  botId: integer("bot_id")
    .notNull()
    .references(() => users.id),
  agentType: text("agent_type", { enum: AGENT_TYPES }).notNull(),
  status: text("status", { enum: JOB_STATUSES }).notNull().default("queued"),
  runnerId: integer("runner_id").references(() => runners.id, { onDelete: "set null" }),
  branch: text("branch").notNull(),
  baseBranch: text("base_branch").notNull(),
  // Lets the runner clone and push this project's repo while the job runs.
  tokenHash: text("token_hash").unique(),
  summary: text("summary"),
  error: text("error"),
  commitSha: text("commit_sha"),
  mergeRequestId: integer("merge_request_id"),
  createdAt: createdAt(),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
});

export const MR_STATUSES = ["open", "merged", "closed"] as const;
export type MergeRequestStatus = (typeof MR_STATUSES)[number];

export const mergeRequests = sqliteTable(
  "merge_requests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // Per-project number shown as !1, !2, ...
    number: integer("number").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    sourceBranch: text("source_branch").notNull(),
    targetBranch: text("target_branch").notNull(),
    status: text("status", { enum: MR_STATUSES }).notNull().default("open"),
    // Issue this MR resolves; merging it marks the issue done.
    issueId: integer("issue_id").references(() => issues.id, { onDelete: "set null" }),
    authorId: integer("author_id")
      .notNull()
      .references(() => users.id),
    mergeSha: text("merge_sha"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    mergedAt: integer("merged_at", { mode: "timestamp_ms" }),
  },
  (t) => [uniqueIndex("merge_requests_project_number").on(t.projectId, t.number)],
);

export const mergeRequestComments = sqliteTable("merge_request_comments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  mergeRequestId: integer("merge_request_id")
    .notNull()
    .references(() => mergeRequests.id, { onDelete: "cascade" }),
  authorId: integer("author_id")
    .notNull()
    .references(() => users.id),
  body: text("body").notNull(),
  createdAt: createdAt(),
});

export const WORKSHOP_STATUSES = ["active", "done", "closed"] as const;

// A plan workshop: an agent interviews the user about an idea, keeps a plan document up to
// date, and finally proposes issues.
export const workshops = sqliteTable("workshops", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  status: text("status", { enum: WORKSHOP_STATUSES }).notNull().default("active"),
  botId: integer("bot_id")
    .notNull()
    .references(() => users.id),
  // Branch the agent reads while interviewing.
  baseBranch: text("base_branch").notNull(),
  plan: text("plan").notNull().default(""),
  // JSON array of proposed issues, once the agent has proposed them.
  proposal: text("proposal"),
  // Agent session to resume, and the runner that holds it.
  sessionId: text("session_id"),
  sessionRunnerId: integer("session_runner_id").references(() => runners.id, { onDelete: "set null" }),
  // Set when issues are created; the issue that holds the plan.
  parentIssueId: integer("parent_issue_id").references(() => issues.id, { onDelete: "set null" }),
  createdById: integer("created_by_id")
    .notNull()
    .references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const workshopMessages = sqliteTable("workshop_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  workshopId: integer("workshop_id")
    .notNull()
    .references(() => workshops.id, { onDelete: "cascade" }),
  // "system" messages are Cohort's own notes, e.g. a failed turn.
  role: text("role", { enum: ["user", "agent", "system"] }).notNull(),
  body: text("body").notNull(),
  createdAt: createdAt(),
});
