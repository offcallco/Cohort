import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Blob, Branch, Commit, CommitDetail, FileDiff, TreeEntry } from "@cohort/shared";

// Read-side git plumbing for bare repos. Everything goes through execFile (no shell), refs are
// resolved to a commit sha once with --end-of-options, and paths are passed after "--" or as part
// of "<sha>:<path>", so user input can't become a git option.

const MAX_BLOB_BYTES = 1024 * 1024;
const BINARY_SNIFF_BYTES = 8000;

export class GitError extends Error {}

export function repoDir(reposRoot: string, workspace: string, project: string) {
  return join(reposRoot, workspace, `${project}.git`);
}

function git(gitDir: string, args: string[], input?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      ["--git-dir", gitDir, "-c", "core.quotePath=false", ...args],
      { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (error, stdout, stderr) => {
        if (error) reject(new GitError(stderr.toString().trim() || error.message));
        else resolve(stdout);
      },
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

const text = async (gitDir: string, args: string[], input?: string) =>
  (await git(gitDir, args, input)).toString("utf8");

export async function initBare(gitDir: string) {
  await mkdir(dirname(gitDir), { recursive: true });
  await new Promise<void>((resolve, reject) =>
    execFile("git", ["init", "--bare", "--quiet", "--initial-branch=main", gitDir], (error, _out, stderr) =>
      error ? reject(new GitError(stderr || error.message)) : resolve(),
    ),
  );
}

// Writes one commit containing README.md onto main, without needing a working tree.
export async function commitReadme(
  gitDir: string,
  readme: string,
  author: { name: string; email: string },
) {
  const blob = (await text(gitDir, ["hash-object", "-w", "--stdin"], readme)).trim();
  const tree = (await text(gitDir, ["mktree"], `100644 blob ${blob}\tREADME.md\n`)).trim();
  const env = {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
  };
  const commit = await new Promise<string>((resolve, reject) =>
    execFile(
      "git",
      ["--git-dir", gitDir, "commit-tree", tree, "-m", "Initial commit"],
      { env: { ...process.env, ...env } },
      (error, stdout, stderr) => (error ? reject(new GitError(stderr || error.message)) : resolve(stdout.trim())),
    ),
  );
  await git(gitDir, ["update-ref", "refs/heads/main", commit]);
}

// Refs come from URLs, so keep them to characters git allows and never let one look like a flag.
export function isSafeRef(ref: string) {
  return /^[A-Za-z0-9._\/-]+$/.test(ref) && !ref.startsWith("-") && !ref.includes("..");
}

// Normalizes a repo-relative path from a URL: no leading/trailing slashes, no "." or "..".
export function cleanPath(path: string | undefined): string | null {
  const parts = (path ?? "").split("/").filter(Boolean);
  if (parts.some((p) => p === "." || p === "..")) return null;
  return parts.join("/");
}

export async function resolveCommit(gitDir: string, ref: string): Promise<string | null> {
  if (!isSafeRef(ref)) return null;
  try {
    return (await text(gitDir, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`])).trim();
  } catch {
    return null;
  }
}

export async function branches(gitDir: string): Promise<Branch[]> {
  const out = await text(gitDir, [
    "for-each-ref",
    "--sort=-committerdate",
    "--format=%(refname:short)%00%(objectname)%00%(contents:subject)%00%(committerdate:iso-strict)",
    "refs/heads",
  ]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name = "", sha = "", subject = "", date = ""] = line.split("\0");
      return { name, sha, subject, date };
    });
}

// HEAD's branch if it exists, else the most recently updated branch, else null (empty repo).
export async function defaultBranch(gitDir: string): Promise<string | null> {
  const all = await branches(gitDir);
  if (all.length === 0) return null;
  try {
    const head = (await text(gitDir, ["symbolic-ref", "--short", "HEAD"])).trim();
    if (all.some((b) => b.name === head)) return head;
  } catch {
    // Detached or unset HEAD: fall through.
  }
  return all[0]!.name;
}

export async function tree(gitDir: string, sha: string, path: string): Promise<TreeEntry[] | null> {
  const type = await objectType(gitDir, `${sha}:${path}`);
  if (type !== "tree") return null;
  const out = await text(gitDir, ["ls-tree", "-l", "-z", `${sha}:${path}`]);
  const entries = out
    .split("\0")
    .filter(Boolean)
    .map((record): TreeEntry => {
      const tab = record.indexOf("\t");
      const [, kind, , size] = record.slice(0, tab).split(/\s+/);
      const name = record.slice(tab + 1);
      return {
        name,
        path: path ? `${path}/${name}` : name,
        type: kind as TreeEntry["type"],
        size: size === "-" || size === undefined ? null : Number(size),
      };
    });
  const order = { tree: 0, commit: 1, blob: 2 };
  return entries.sort((a, b) => order[a.type] - order[b.type] || a.name.localeCompare(b.name));
}

async function objectType(gitDir: string, spec: string): Promise<string | null> {
  try {
    return (await text(gitDir, ["cat-file", "-t", spec])).trim();
  } catch {
    return null;
  }
}

export async function blob(gitDir: string, sha: string, path: string): Promise<Blob | null> {
  const spec = `${sha}:${path}`;
  if ((await objectType(gitDir, spec)) !== "blob") return null;
  const size = Number((await text(gitDir, ["cat-file", "-s", spec])).trim());
  if (size > MAX_BLOB_BYTES) return { path, size, content: null, binary: false, truncated: true };
  const data = await git(gitDir, ["cat-file", "blob", spec]);
  const binary = data.subarray(0, BINARY_SNIFF_BYTES).includes(0);
  return { path, size, content: binary ? null : data.toString("utf8"), binary, truncated: false };
}

const COMMIT_FORMAT = "%H%x00%P%x00%an%x00%ae%x00%aI%x00%s";

function parseCommit(record: string): Commit {
  const [sha = "", parents = "", authorName = "", authorEmail = "", date = "", subject = ""] =
    record.split("\0");
  return { sha, parents: parents.split(" ").filter(Boolean), authorName, authorEmail, date, subject };
}

export async function log(
  gitDir: string,
  sha: string,
  { path, skip, limit }: { path: string; skip: number; limit: number },
): Promise<{ commits: Commit[]; hasMore: boolean }> {
  const args = ["log", `--format=${COMMIT_FORMAT}%x1e`, `-n${limit + 1}`, `--skip=${skip}`, sha];
  if (path) args.push("--", path);
  const commits = (await text(gitDir, args))
    .split("\x1e")
    .map((r) => r.trim())
    .filter(Boolean)
    .map(parseCommit);
  return { commits: commits.slice(0, limit), hasMore: commits.length > limit };
}

export async function commitDetail(gitDir: string, sha: string): Promise<CommitDetail> {
  const meta = await text(gitDir, ["show", "-s", `--format=${COMMIT_FORMAT}%x00%b`, sha]);
  const lastNul = meta.lastIndexOf("\0");
  const commit = parseCommit(meta.slice(0, lastNul));
  const body = meta.slice(lastNul + 1).trim();
  const diffArgs = ["--no-color", "--no-ext-diff", "-M"];
  const patch = commit.parents[0]
    ? await text(gitDir, ["diff", ...diffArgs, commit.parents[0], sha])
    : await text(gitDir, ["diff-tree", "-p", "--root", "--no-commit-id", ...diffArgs, sha]);
  return { ...commit, body, files: parsePatch(patch) };
}

// Splits `git diff` output into one entry per file.
export function parsePatch(patch: string): FileDiff[] {
  const files: FileDiff[] = [];
  const chunks = patch.split(/^diff --git /m).slice(1);
  for (const chunk of chunks) {
    const lines = chunk.split("\n");
    const header = lines[0] ?? "";
    const hunkStart = lines.findIndex((l) => l.startsWith("@@"));
    const meta = hunkStart === -1 ? lines : lines.slice(0, hunkStart);
    const hunks = hunkStart === -1 ? [] : lines.slice(hunkStart);

    // "a/<old> b/<new>" for unquoted paths; overridden by ---/+++ and rename lines when present.
    const fromHeader = header.match(/^a\/(.*) b\/(.*)$/);
    let oldPath: string | null = fromHeader?.[1] ?? null;
    let newPath: string | null = fromHeader?.[2] ?? null;
    let status: FileDiff["status"] = "modified";
    let binary = false;
    for (const line of meta) {
      if (line.startsWith("new file mode")) status = "added";
      else if (line.startsWith("deleted file mode")) status = "deleted";
      else if (line.startsWith("rename from ")) {
        status = "renamed";
        oldPath = line.slice("rename from ".length);
      } else if (line.startsWith("rename to ")) newPath = line.slice("rename to ".length);
      else if (line.startsWith("--- ")) oldPath = line === "--- /dev/null" ? null : line.slice(6);
      else if (line.startsWith("+++ ")) newPath = line === "+++ /dev/null" ? null : line.slice(6);
      else if (line.startsWith("Binary files ")) binary = true;
    }
    if (status === "added") oldPath = null;
    if (status === "deleted") newPath = null;

    let additions = 0;
    let deletions = 0;
    for (const line of hunks) {
      if (line.startsWith("+")) additions++;
      else if (line.startsWith("-")) deletions++;
    }
    const body = hunks.join("\n").replace(/\n$/, "");
    files.push({ oldPath, newPath, status, binary, additions, deletions, patch: body });
  }
  return files;
}
