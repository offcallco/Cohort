import { and, desc, eq, inArray, max } from "drizzle-orm";
import { issues, mergeRequestComments, mergeRequests, projects, users, workspaces, type Db } from "@cohort/db";
import type { IssueComment, MergeRequestDetail, MergeRequestStatus, MergeRequestSummary, User } from "@cohort/shared";
import {
  branchSha,
  canMerge,
  commitsBetween,
  deleteBranch,
  diffBetween,
  mergeBranches,
  repoDir,
} from "../git/repo.ts";

type MrRow = typeof mergeRequests.$inferSelect;

export function createMergeRequest(
  db: Db,
  values: {
    projectId: number;
    authorId: number;
    title: string;
    description: string;
    sourceBranch: string;
    targetBranch: string;
    issueId?: number | null;
  },
): MrRow {
  return db.transaction((tx) => {
    const next =
      (tx.select({ n: max(mergeRequests.number) }).from(mergeRequests).where(eq(mergeRequests.projectId, values.projectId)).get()?.n ?? 0) + 1;
    return tx
      .insert(mergeRequests)
      .values({ ...values, number: next })
      .returning()
      .get();
  });
}

export function findMergeRequest(db: Db, projectId: number, number: number) {
  return db
    .select()
    .from(mergeRequests)
    .where(and(eq(mergeRequests.projectId, projectId), eq(mergeRequests.number, number)))
    .get();
}

function usersById(db: Db, ids: number[]): Map<number, User> {
  if (ids.length === 0) return new Map();
  return new Map(
    db
      .select({ id: users.id, username: users.username, kind: users.kind })
      .from(users)
      .where(inArray(users.id, [...new Set(ids)]))
      .all()
      .map((u) => [u.id, u]),
  );
}

function projectPath(db: Db, projectId: number) {
  return db
    .select({ workspace: workspaces.slug, project: projects.slug })
    .from(projects)
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .where(eq(projects.id, projectId))
    .get()!;
}

function summarize(db: Db, rows: MrRow[]): MergeRequestSummary[] {
  const people = usersById(db, rows.map((r) => r.authorId));
  const issueIds = rows.map((r) => r.issueId).filter((id): id is number => id !== null);
  const issueMap = new Map(
    issueIds.length ? db.select().from(issues).where(inArray(issues.id, issueIds)).all().map((i) => [i.id, i]) : [],
  );
  return rows.map((r) => {
    const { workspace, project } = projectPath(db, r.projectId);
    const issue = r.issueId ? issueMap.get(r.issueId) : undefined;
    return {
      id: r.id,
      number: r.number,
      project: `${workspace}/${project}`,
      title: r.title,
      status: r.status,
      sourceBranch: r.sourceBranch,
      targetBranch: r.targetBranch,
      author: people.get(r.authorId)!,
      issue: issue ? { number: issue.number, title: issue.title, status: issue.status } : null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  });
}

export function listMergeRequests(db: Db, projectId: number, status?: MergeRequestStatus) {
  const where = [eq(mergeRequests.projectId, projectId)];
  if (status) where.push(eq(mergeRequests.status, status));
  return summarize(db, db.select().from(mergeRequests).where(and(...where)).orderBy(desc(mergeRequests.updatedAt)).all());
}

export async function mergeRequestDetail(
  db: Db,
  reposRoot: string,
  row: MrRow,
): Promise<Omit<MergeRequestDetail, "jobs" | "pipeline" | "pipelinesMustSucceed">> {
  const [summary] = summarize(db, [row]);
  const { workspace, project } = projectPath(db, row.projectId);
  const gitDir = repoDir(reposRoot, workspace, project);

  // Merged MRs compare against the merge commit's first parent, so the diff stays visible
  // after the source branch is deleted.
  let base: string | null;
  let head: string | null;
  if (row.status === "merged" && row.mergeSha) {
    base = `${row.mergeSha}^1`;
    head = `${row.mergeSha}^2`;
  } else {
    base = await branchSha(gitDir, row.targetBranch);
    head = await branchSha(gitDir, row.sourceBranch);
  }

  const commentRows = db
    .select()
    .from(mergeRequestComments)
    .where(eq(mergeRequestComments.mergeRequestId, row.id))
    .orderBy(mergeRequestComments.createdAt, mergeRequestComments.id)
    .all();
  const people = usersById(db, commentRows.map((c) => c.authorId));
  const comments: IssueComment[] = commentRows.map((c) => ({
    id: c.id,
    author: people.get(c.authorId)!,
    body: c.body,
    createdAt: c.createdAt.toISOString(),
  }));

  const ready = base !== null && head !== null;
  return {
    ...summary!,
    description: row.description,
    mergeable: row.status === "open" && ready ? await canMerge(gitDir, base!, head!) : null,
    commits: ready ? await commitsBetween(gitDir, base!, head!) : [],
    files: ready ? await diffBetween(gitDir, base!, head!) : [],
    comments,
    mergeSha: row.mergeSha,
    mergedAt: row.mergedAt?.toISOString() ?? null,
  };
}

// Merges, records it, and marks the linked issue done.
export async function mergeMergeRequest(
  db: Db,
  reposRoot: string,
  row: MrRow,
  user: User,
  deleteSource: boolean,
) {
  const { workspace, project } = projectPath(db, row.projectId);
  const gitDir = repoDir(reposRoot, workspace, project);
  const issue = row.issueId ? db.select().from(issues).where(eq(issues.id, row.issueId)).get() : undefined;
  const message = `Merge branch '${row.sourceBranch}' into '${row.targetBranch}'\n\n${row.title}\n\nSee merge request !${row.number}${issue ? `\nCloses #${issue.number}` : ""}`;
  const sha = await mergeBranches(gitDir, row.targetBranch, row.sourceBranch, message, {
    name: user.username,
    email: `${user.username}@cohort.local`,
  });
  const now = new Date();
  db.update(mergeRequests)
    .set({ status: "merged", mergeSha: sha, mergedById: user.id, mergedAt: now, updatedAt: now })
    .where(eq(mergeRequests.id, row.id))
    .run();
  if (issue) db.update(issues).set({ status: "done", updatedAt: now }).where(eq(issues.id, issue.id)).run();
  if (deleteSource) await deleteBranch(gitDir, row.sourceBranch);
  return findMergeRequest(db, row.projectId, row.number)!;
}

export function setMergeRequestStatus(db: Db, row: MrRow, status: "open" | "closed") {
  db.update(mergeRequests).set({ status, updatedAt: new Date() }).where(eq(mergeRequests.id, row.id)).run();
  return findMergeRequest(db, row.projectId, row.number)!;
}

export function addMergeRequestComment(db: Db, row: MrRow, authorId: number, body: string) {
  db.insert(mergeRequestComments).values({ mergeRequestId: row.id, authorId, body }).run();
  db.update(mergeRequests).set({ updatedAt: new Date() }).where(eq(mergeRequests.id, row.id)).run();
}
