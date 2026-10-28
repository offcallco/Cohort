import { and, count, desc, eq, inArray, max, ne, sql, type SQL } from "drizzle-orm";
import {
  issueComments,
  issueDependencies,
  issueLabels,
  issues,
  labels,
  projects,
  users,
  workspaces,
  type Db,
} from "@cohort/db";
import type {
  CreateIssueBody,
  IssueDetail,
  IssueRef,
  IssueStatus,
  IssueSummary,
  Label,
  UpdateIssueBody,
  User,
} from "@cohort/shared";

type IssueRow = typeof issues.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// Thrown for requests that are well-formed but not allowed (cycles, unknown issues, ...).
export class IssueError extends Error {}

const LABEL_COLORS = ["#4f46e5", "#0891b2", "#059669", "#ca8a04", "#ea580c", "#dc2626", "#db2777", "#7c3aed"];

function labelColor(name: string) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return LABEL_COLORS[hash % LABEL_COLORS.length]!;
}

const ref = (row: Pick<IssueRow, "number" | "title" | "status">): IssueRef => ({
  number: row.number,
  title: row.title,
  status: row.status,
});

export interface ListFilter {
  // "open" means anything not done.
  status?: IssueStatus | "open";
  label?: string;
  q?: string;
}

function filterConditions(db: Db, filter: ListFilter): SQL[] {
  const where: SQL[] = [];
  if (filter.status === "open") where.push(ne(issues.status, "done"));
  else if (filter.status) where.push(eq(issues.status, filter.status));
  if (filter.q) {
    const pattern = `%${filter.q.replace(/[\\%_]/g, "\\$&")}%`;
    where.push(sql`${issues.title} like ${pattern} escape '\\'`);
  }
  if (filter.label) {
    const withLabel = db
      .select({ id: issueLabels.issueId })
      .from(issueLabels)
      .innerJoin(labels, eq(labels.id, issueLabels.labelId))
      .where(eq(labels.name, filter.label));
    where.push(inArray(issues.id, withLabel));
  }
  return where;
}

export function listIssues(db: Db, scope: { projectId: number } | { workspaceId: number }, filter: ListFilter) {
  const where = filterConditions(db, filter);
  where.push(
    "projectId" in scope ? eq(issues.projectId, scope.projectId) : eq(projects.workspaceId, scope.workspaceId),
  );
  const rows = db
    .select({ issue: issues })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(and(...where))
    .orderBy(desc(issues.updatedAt))
    .all()
    .map((r) => r.issue);
  return summarize(db, rows);
}

// Builds IssueSummary objects for `rows` with a fixed number of queries.
function summarize(db: Db, rows: IssueRow[]): IssueSummary[] {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const projectPaths = new Map(
    db
      .select({ id: projects.id, path: sql<string>`${workspaces.slug} || '/' || ${projects.slug}` })
      .from(projects)
      .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
      .where(inArray(projects.id, [...new Set(rows.map((r) => r.projectId))]))
      .all()
      .map((p) => [p.id, p.path]),
  );

  const labelsByIssue = new Map<number, Label[]>();
  for (const l of db
    .select({ issueId: issueLabels.issueId, id: labels.id, name: labels.name, color: labels.color })
    .from(issueLabels)
    .innerJoin(labels, eq(labels.id, issueLabels.labelId))
    .where(inArray(issueLabels.issueId, ids))
    .orderBy(labels.name)
    .all()) {
    const list = labelsByIssue.get(l.issueId) ?? [];
    list.push({ id: l.id, name: l.name, color: l.color });
    labelsByIssue.set(l.issueId, list);
  }

  const dep = sql.raw("dep");
  const waiting = new Map(
    db
      .select({ issueId: issueDependencies.issueId, n: count() })
      .from(issueDependencies)
      .innerJoin(sql`${issues} as ${dep}`, sql`${dep}.id = ${issueDependencies.dependsOnId}`)
      .where(and(inArray(issueDependencies.issueId, ids), sql`${dep}.status != 'done'`))
      .groupBy(issueDependencies.issueId)
      .all()
      .map((r) => [r.issueId, r.n]),
  );

  const children = new Map(
    db
      .select({ parentId: issues.parentId, n: count() })
      .from(issues)
      .where(inArray(issues.parentId, ids))
      .groupBy(issues.parentId)
      .all()
      .map((r) => [r.parentId!, r.n]),
  );

  const comments = new Map(
    db
      .select({ issueId: issueComments.issueId, n: count() })
      .from(issueComments)
      .where(inArray(issueComments.issueId, ids))
      .groupBy(issueComments.issueId)
      .all()
      .map((r) => [r.issueId, r.n]),
  );

  const userIds = rows.map((r) => r.assigneeId).filter((id): id is number => id !== null);
  const userMap = usersById(db, userIds);

  const parentIds = rows.map((r) => r.parentId).filter((id): id is number => id !== null);
  const parentNumbers = new Map(
    parentIds.length
      ? db
          .select({ id: issues.id, number: issues.number })
          .from(issues)
          .where(inArray(issues.id, parentIds))
          .all()
          .map((p) => [p.id, p.number])
      : [],
  );

  return rows.map((r) => ({
    id: r.id,
    project: projectPaths.get(r.projectId) ?? "",
    ...ref(r),
    labels: labelsByIssue.get(r.id) ?? [],
    assignee: r.assigneeId !== null ? (userMap.get(r.assigneeId) ?? null) : null,
    parent: r.parentId !== null ? (parentNumbers.get(r.parentId) ?? null) : null,
    waitingOn: waiting.get(r.id) ?? 0,
    children: children.get(r.id) ?? 0,
    comments: comments.get(r.id) ?? 0,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

function usersById(db: Db | Tx, ids: number[]): Map<number, User> {
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

export function findIssue(db: Db, projectId: number, number: number) {
  return db
    .select()
    .from(issues)
    .where(and(eq(issues.projectId, projectId), eq(issues.number, number)))
    .get();
}

export function issueDetail(db: Db, row: IssueRow): IssueDetail {
  const [summary] = summarize(db, [row]);
  const refsWhere = (where: SQL) =>
    db.select().from(issues).where(where).orderBy(issues.number).all().map(ref);

  const dependsOnIds = db
    .select({ id: issueDependencies.dependsOnId })
    .from(issueDependencies)
    .where(eq(issueDependencies.issueId, row.id))
    .all()
    .map((d) => d.id);
  const blocksIds = db
    .select({ id: issueDependencies.issueId })
    .from(issueDependencies)
    .where(eq(issueDependencies.dependsOnId, row.id))
    .all()
    .map((d) => d.id);

  const commentRows = db
    .select()
    .from(issueComments)
    .where(eq(issueComments.issueId, row.id))
    .orderBy(issueComments.createdAt, issueComments.id)
    .all();
  const people = usersById(db, [row.authorId, ...commentRows.map((c) => c.authorId)]);

  const parent = row.parentId ? db.select().from(issues).where(eq(issues.id, row.parentId)).get() : undefined;

  return {
    ...summary!,
    body: row.body,
    author: people.get(row.authorId)!,
    parentIssue: parent ? ref(parent) : null,
    childIssues: refsWhere(eq(issues.parentId, row.id)),
    dependsOn: dependsOnIds.length ? refsWhere(inArray(issues.id, dependsOnIds)) : [],
    blocks: blocksIds.length ? refsWhere(inArray(issues.id, blocksIds)) : [],
    commentList: commentRows.map((c) => ({
      id: c.id,
      author: people.get(c.authorId)!,
      body: c.body,
      createdAt: c.createdAt.toISOString(),
    })),
  };
}

// --- Writes ---------------------------------------------------------------------------------

function idForNumber(tx: Tx, projectId: number, number: number): number {
  const row = tx
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.projectId, projectId), eq(issues.number, number)))
    .get();
  if (!row) throw new IssueError(`Issue #${number} doesn't exist in this project`);
  return row.id;
}

function userIdFor(tx: Tx, username: string | null): number | null {
  if (username === null) return null;
  const user = tx.select({ id: users.id }).from(users).where(eq(users.username, username)).get();
  if (!user) throw new IssueError(`Unknown user "${username}"`);
  return user.id;
}

function setParent(tx: Tx, projectId: number, issueId: number, parent: number | null) {
  if (parent === null) {
    tx.update(issues).set({ parentId: null }).where(eq(issues.id, issueId)).run();
    return;
  }
  const parentId = idForNumber(tx, projectId, parent);
  // Walk up from the new parent; reaching this issue would make a loop.
  for (let cursor: number | null = parentId; cursor !== null; ) {
    if (cursor === issueId) throw new IssueError("An issue can't be its own parent or ancestor");
    cursor = tx.select({ parentId: issues.parentId }).from(issues).where(eq(issues.id, cursor)).get()?.parentId ?? null;
  }
  tx.update(issues).set({ parentId }).where(eq(issues.id, issueId)).run();
}

function setDependencies(tx: Tx, projectId: number, issueId: number, numbers: number[]) {
  const ids = [...new Set(numbers.map((n) => idForNumber(tx, projectId, n)))];
  if (ids.includes(issueId)) throw new IssueError("An issue can't wait on itself");
  // Any path from a new dependency back to this issue would be a cycle.
  const seen = new Set<number>();
  const queue = [...ids];
  while (queue.length) {
    const current = queue.pop()!;
    if (current === issueId) throw new IssueError("That would create a dependency cycle");
    if (seen.has(current)) continue;
    seen.add(current);
    for (const d of tx
      .select({ id: issueDependencies.dependsOnId })
      .from(issueDependencies)
      .where(eq(issueDependencies.issueId, current))
      .all()) {
      queue.push(d.id);
    }
  }
  tx.delete(issueDependencies).where(eq(issueDependencies.issueId, issueId)).run();
  if (ids.length) {
    tx.insert(issueDependencies)
      .values(ids.map((dependsOnId) => ({ issueId, dependsOnId })))
      .run();
  }
}

function setLabels(tx: Tx, projectId: number, issueId: number, names: string[]) {
  const unique = [...new Set(names)];
  for (const name of unique) {
    tx.insert(labels).values({ projectId, name, color: labelColor(name) }).onConflictDoNothing().run();
  }
  tx.delete(issueLabels).where(eq(issueLabels.issueId, issueId)).run();
  if (unique.length === 0) return;
  const ids = tx
    .select({ id: labels.id })
    .from(labels)
    .where(and(eq(labels.projectId, projectId), inArray(labels.name, unique)))
    .all();
  tx.insert(issueLabels)
    .values(ids.map((l) => ({ issueId, labelId: l.id })))
    .run();
}

export function createIssue(
  db: Db,
  projectId: number,
  authorId: number,
  body: Required<CreateIssueBody>,
): IssueRow {
  return db.transaction((tx) => {
    const next = (tx.select({ n: max(issues.number) }).from(issues).where(eq(issues.projectId, projectId)).get()?.n ?? 0) + 1;
    const row = tx
      .insert(issues)
      .values({
        projectId,
        number: next,
        title: body.title,
        body: body.body,
        status: body.status,
        authorId,
        assigneeId: userIdFor(tx, body.assignee),
      })
      .returning()
      .get();
    if (body.parent !== null) setParent(tx, projectId, row.id, body.parent);
    if (body.dependsOn.length) setDependencies(tx, projectId, row.id, body.dependsOn);
    if (body.labels.length) setLabels(tx, projectId, row.id, body.labels);
    return tx.select().from(issues).where(eq(issues.id, row.id)).get()!;
  });
}

export function updateIssue(db: Db, row: IssueRow, body: UpdateIssueBody): IssueRow {
  return db.transaction((tx) => {
    const fields: Partial<typeof issues.$inferInsert> = { updatedAt: new Date() };
    if (body.title !== undefined) fields.title = body.title;
    if (body.body !== undefined) fields.body = body.body;
    if (body.status !== undefined) fields.status = body.status;
    if (body.assignee !== undefined) fields.assigneeId = userIdFor(tx, body.assignee);
    tx.update(issues).set(fields).where(eq(issues.id, row.id)).run();
    if (body.parent !== undefined) setParent(tx, row.projectId, row.id, body.parent);
    if (body.dependsOn !== undefined) setDependencies(tx, row.projectId, row.id, body.dependsOn);
    if (body.labels !== undefined) setLabels(tx, row.projectId, row.id, body.labels);
    return tx.select().from(issues).where(eq(issues.id, row.id)).get()!;
  });
}

export function addComment(db: Db, row: IssueRow, authorId: number, body: string) {
  db.transaction((tx) => {
    tx.insert(issueComments).values({ issueId: row.id, authorId, body }).run();
    tx.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, row.id)).run();
  });
}

export function projectLabels(db: Db, projectId: number): Label[] {
  return db
    .select({ id: labels.id, name: labels.name, color: labels.color })
    .from(labels)
    .where(eq(labels.projectId, projectId))
    .orderBy(labels.name)
    .all();
}
