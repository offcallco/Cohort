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

export interface User {
  id: number;
  username: string;
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
