import { z } from "zod";

// Request bodies and response shapes for the Cohort HTTP API.
// The server validates with these; the web app uses the inferred types.

export const credentials = z.object({
  username: z
    .string()
    .trim()
    .min(1, "Username is required")
    .max(64)
    .regex(/^[a-zA-Z0-9_.-]+$/, "Use letters, numbers, dots, dashes or underscores"),
  password: z.string().min(8, "Password must be at least 8 characters").max(256),
});
export type Credentials = z.infer<typeof credentials>;

export const createTokenBody = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
});
export type CreateTokenBody = z.infer<typeof createTokenBody>;

export * from "./protocol.ts";
import type { AgentInfo, AgentType, JobKind } from "./protocol.ts";

export interface User {
  id: number;
  username: string;
  kind: "human" | "bot";
}

export interface Status {
  // True until the first account has been created on this install.
  setupRequired: boolean;
  user: User | null;
  version: string;
}

export interface AccessToken {
  id: number;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

// Returned once, when a token is created. The plain token is never shown again.
export interface CreatedAccessToken extends AccessToken {
  token: string;
}

export interface ApiError {
  error: string;
}

// Top-level URL segments the UI and server use, so no workspace can take them.
export const RESERVED_SLUGS = [
  "api",
  "assets",
  "settings",
  "login",
  "logout",
  "setup",
  "new",
  "help",
  "admin",
  "runners",
  "workspaces",
] as const;

export const slug = z
  .string()
  .trim()
  .min(1, "Required")
  .max(64)
  .regex(
    /^[a-z0-9][a-z0-9_.-]*$/,
    "Use lowercase letters, numbers, dots, dashes or underscores, starting with a letter or number",
  )
  .refine((s) => !s.endsWith(".git"), "Can't end in .git")
  .refine((s) => !s.includes(".."), "Can't contain ..");

export const createWorkspaceBody = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  slug: slug.refine(
    (s) => !(RESERVED_SLUGS as readonly string[]).includes(s),
    "That name is reserved",
  ),
  description: z.string().trim().max(500).default(""),
});
export type CreateWorkspaceBody = z.input<typeof createWorkspaceBody>;

export const createProjectBody = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  slug,
  description: z.string().trim().max(500).default(""),
  // Create an initial commit with a README so the repo can be cloned right away.
  initReadme: z.boolean().default(false),
});
export type CreateProjectBody = z.input<typeof createProjectBody>;

export interface Workspace {
  id: number;
  slug: string;
  name: string;
  description: string;
  createdAt: string;
}

export interface Project {
  id: number;
  workspace: string;
  slug: string;
  name: string;
  description: string;
  createdAt: string;
  // Relative to the server origin, e.g. "/acme/api.git".
  clonePath: string;
  // Null while the repo has no commits.
  defaultBranch: string | null;
  runnerContext: string;
}

export interface WorkspaceWithProjects extends Workspace {
  projects: Project[];
}

export interface Branch {
  name: string;
  sha: string;
  subject: string;
  date: string;
}

export interface TreeEntry {
  name: string;
  path: string;
  type: "tree" | "blob" | "commit";
  size: number | null;
}

export interface Blob {
  path: string;
  size: number;
  // Null when the file is binary or too large to show.
  content: string | null;
  binary: boolean;
  truncated: boolean;
}

export interface Commit {
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  date: string;
  subject: string;
}

export interface FileDiff {
  oldPath: string | null;
  newPath: string | null;
  status: "added" | "deleted" | "modified" | "renamed";
  binary: boolean;
  additions: number;
  deletions: number;
  // Unified diff hunks, starting at the first "@@" line.
  patch: string;
}

export interface CommitDetail extends Commit {
  body: string;
  files: FileDiff[];
}

// Issues

export const ISSUE_STATUSES = ["todo", "in_progress", "review", "done", "blocked"] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const STATUS_LABELS: Record<IssueStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  review: "In review",
  done: "Done",
  blocked: "Blocked",
};

const issueNumber = z.number().int().positive();
const labelName = z.string().trim().min(1).max(50);

export const createIssueBody = z.object({
  title: z.string().trim().min(1, "Title is required").max(255),
  body: z.string().max(100_000).default(""),
  status: z.enum(ISSUE_STATUSES).default("todo"),
  labels: z.array(labelName).max(20).default([]),
  parent: issueNumber.nullable().default(null),
  dependsOn: z.array(issueNumber).max(50).default([]),
  assignee: z.string().nullable().default(null),
});
export type CreateIssueBody = z.input<typeof createIssueBody>;

// Every field optional; only the ones sent are changed.
export const updateIssueBody = z.object({
  title: z.string().trim().min(1, "Title is required").max(255).optional(),
  body: z.string().max(100_000).optional(),
  status: z.enum(ISSUE_STATUSES).optional(),
  labels: z.array(labelName).max(20).optional(),
  parent: issueNumber.nullable().optional(),
  dependsOn: z.array(issueNumber).max(50).optional(),
  assignee: z.string().nullable().optional(),
});
export type UpdateIssueBody = z.input<typeof updateIssueBody>;

export const createCommentBody = z.object({
  body: z.string().trim().min(1, "Comment can't be empty").max(100_000),
});

export interface Label {
  id: number;
  name: string;
  color: string;
}

export interface IssueRef {
  number: number;
  title: string;
  status: IssueStatus;
}

export interface IssueSummary extends IssueRef {
  id: number;
  // "<workspace>/<project>", for lists that span projects.
  project: string;
  labels: Label[];
  assignee: User | null;
  parent: number | null;
  // Dependencies that aren't done yet.
  waitingOn: number;
  children: number;
  comments: number;
  createdAt: string;
  updatedAt: string;
}

export interface IssueComment {
  id: number;
  author: User;
  body: string;
  createdAt: string;
}

export interface IssueDetail extends IssueSummary {
  body: string;
  origin: "user" | "workshop" | "split";
  branch: string | null;
  // A split over the runner's limit, waiting for approval.
  splitProposal: { issues: ProposedIssue[]; limit: number } | null;
  author: User;
  parentIssue: IssueRef | null;
  childIssues: IssueRef[];
  dependsOn: IssueRef[];
  // Issues that wait on this one.
  blocks: IssueRef[];
  commentList: IssueComment[];
}

export const updateProjectBody = z.object({
  description: z.string().trim().max(500).optional(),
  runnerContext: z.string().max(20_000).optional(),
});

// Runners and jobs

export const createRunnerBody = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
});

export interface Runner {
  id: number;
  name: string;
  prefix: string;
  online: boolean;
  agents: AgentInfo[];
  concurrent: number | null;
  runningJobs: number;
  lastSeenAt: string | null;
  createdAt: string;
}

export interface Bot extends User {
  agentType: AgentType;
  // True when at least one connected runner can run this bot's agent.
  available: boolean;
}

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

export interface Job {
  id: number;
  project: string;
  kind: JobKind;
  issue: IssueRef | null;
  workshop: number | null;
  bot: string;
  agentType: AgentType;
  status: JobStatus;
  runner: string | null;
  branch: string;
  baseBranch: string;
  summary: string | null;
  error: string | null;
  commitSha: string | null;
  mergeRequest: number | null;
  // Why a queued job isn't running yet, e.g. no runner online for its agent.
  waitingReason: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

// Merge requests

export type MergeRequestStatus = "open" | "merged" | "closed";

export const createMergeRequestBody = z.object({
  title: z.string().trim().min(1, "Title is required").max(255),
  description: z.string().max(100_000).default(""),
  sourceBranch: z.string().min(1),
  targetBranch: z.string().min(1),
});

export const mergeBody = z.object({
  deleteSourceBranch: z.boolean().default(true),
});

export interface MergeRequestSummary {
  id: number;
  number: number;
  project: string;
  title: string;
  status: MergeRequestStatus;
  sourceBranch: string;
  targetBranch: string;
  author: User;
  issue: IssueRef | null;
  createdAt: string;
  updatedAt: string;
}

export interface MergeRequestDetail extends MergeRequestSummary {
  description: string;
  // Null once merged or closed, or when a branch is gone.
  mergeable: boolean | null;
  commits: Commit[];
  files: FileDiff[];
  comments: IssueComment[];
  jobs: Job[];
  mergeSha: string | null;
  mergedAt: string | null;
}

// Plan workshops

export const createWorkshopBody = z.object({
  idea: z.string().trim().min(1, "Describe your idea").max(20_000),
  bot: z.string().min(1, "Pick an agent"),
  title: z.string().trim().max(120).optional(),
});

export const workshopMessageBody = z.object({
  body: z.string().trim().min(1, "Message can't be empty").max(20_000),
});

export const proposedIssue = z.object({
  // Short id used to refer to this issue in dependsOn.
  key: z.string().trim().min(1).max(40),
  title: z.string().trim().min(1, "Every issue needs a title").max(255),
  body: z.string().max(100_000).default(""),
  labels: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
  dependsOn: z.array(z.string()).max(50).default([]),
});
export type ProposedIssue = z.infer<typeof proposedIssue>;

export const createWorkshopIssuesBody = z.object({
  issues: z.array(proposedIssue).min(1, "Keep at least one issue").max(50),
  // Also create a parent issue holding the plan, with the others as its sub-issues.
  parentIssue: z.boolean().default(true),
});

export type WorkshopStatus = "active" | "done" | "closed";

export interface WorkshopMessage {
  id: number;
  role: "user" | "agent" | "system";
  body: string;
  createdAt: string;
}

export interface WorkshopSummary {
  id: number;
  project: string;
  title: string;
  status: WorkshopStatus;
  bot: string;
  messages: number;
  // True while the agent is working on (or queued for) a reply.
  waiting: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WorkshopDetail extends WorkshopSummary {
  baseBranch: string;
  plan: string;
  proposal: ProposedIssue[] | null;
  messageList: WorkshopMessage[];
  // The agent's current or most recent turn.
  job: Job | null;
  parentIssue: IssueRef | null;
  createdIssues: IssueRef[];
}

export const splitDecisionBody = z.object({
  // true: create the proposed sub-issues; false: do the issue as one job.
  approve: z.boolean(),
});
