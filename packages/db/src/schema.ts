import { sql } from "drizzle-orm";
import {
  integer,
  primaryKey,
  real,
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
    // Block merging until the merge request's pipeline has passed.
    pipelinesMustSucceed: integer("pipelines_must_succeed", { mode: "boolean" }).notNull().default(false),
    // Run pipelines for agents' merge requests without waiting for a person to start them.
    autoRunAgentPipelines: integer("auto_run_agent_pipelines", { mode: "boolean" }).notNull().default(false),
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
    // Where the issue came from. Sub-issues an agent split off ("split") build on their
    // parent's branch instead of opening their own merge request.
    origin: text("origin", { enum: ["user", "workshop", "split"] }).notNull().default("user"),
    // Branch the issue's work happens on, once an agent has started it.
    branch: text("branch"),
    // A split waiting for approval because it's over the runner's max_subtasks:
    // JSON { issues: ProposedIssue[], limit: number }.
    splitProposal: text("split_proposal"),
    // The agent's plan for the issue (markdown), and whether a person has approved it.
    // Issues people assign directly wait for approval; workshop issues and sub-issues don't.
    plan: text("plan"),
    planStatus: text("plan_status", { enum: ["pending", "approved", "changes_requested", "rejected", "auto"] }),
    // An instruction for the next agent run, e.g. from Redirect while one is still stopping.
    pendingInstruction: text("pending_instruction"),
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
  // "split" asks the agent how to break an issue up; "resolve" fixes a conflict merging a
  // sub-issue's branch into its parent's (branch = parent's branch, baseBranch = sub-issue's).
  kind: text("kind", { enum: ["implement", "workshop", "split", "resolve"] }).notNull(),
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
  // A person's instruction for this run: feedback on a plan, requested changes, a redirect.
  instruction: text("instruction"),
  summary: text("summary"),
  error: text("error"),
  commitSha: text("commit_sha"),
  // What the agent reported the run cost, when it reports one (Claude Code does).
  costUsd: real("cost_usd"),
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
    mergedById: integer("merged_by_id").references(() => users.id),
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

export const PIPELINE_STATUSES = ["manual", "pending", "running", "success", "failed", "canceled"] as const;
export const CI_JOB_STATUSES = ["created", "pending", "running", "success", "failed", "canceled", "skipped"] as const;

// A CI pipeline: the jobs in .cohort-ci.yml, run for one commit.
export const pipelines = sqliteTable("pipelines", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  ref: text("ref").notNull(),
  sha: text("sha").notNull(),
  // "manual" pipelines wait for a person to start them (e.g. agents' merge requests).
  status: text("status", { enum: PIPELINE_STATUSES }).notNull(),
  source: text("source", { enum: ["push", "merge_request", "web"] }).notNull(),
  triggeredById: integer("triggered_by_id")
    .notNull()
    .references(() => users.id),
  mergeRequestId: integer("merge_request_id").references(() => mergeRequests.id, { onDelete: "set null" }),
  // Set when .cohort-ci.yml couldn't be read.
  error: text("error"),
  createdAt: createdAt(),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
});

export const pipelineJobs = sqliteTable("pipeline_jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  pipelineId: integer("pipeline_id")
    .notNull()
    .references(() => pipelines.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  stage: text("stage").notNull(),
  stageIndex: integer("stage_index").notNull(),
  // JSON string[] of commands, and JSON Record<string, string> of variables.
  script: text("script").notNull(),
  variables: text("variables").notNull().default("{}"),
  allowFailure: integer("allow_failure", { mode: "boolean" }).notNull().default(false),
  status: text("status", { enum: CI_JOB_STATUSES }).notNull().default("created"),
  runnerId: integer("runner_id").references(() => runners.id, { onDelete: "set null" }),
  // Read-only git credential for the job while it runs.
  tokenHash: text("token_hash").unique(),
  error: text("error"),
  createdAt: createdAt(),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
});
