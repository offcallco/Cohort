import { and, desc, eq, inArray } from "drizzle-orm";
import { issues, jobs, projects, users, workshopMessages, workshops, workspaces, type Db } from "@cohort/db";
import type {
  IssueRef,
  ProposedIssue,
  User,
  WorkshopDetail,
  WorkshopSummary,
  WorkshopTurn,
} from "@cohort/shared";
import { defaultBranch, repoDir } from "../git/repo.ts";
import { createIssue, updateIssue } from "../issues/service.ts";
import { ACTIVE, JobError, type JobResult, type Jobs, type WorkshopHooks } from "../jobs/service.ts";
import { orderIssues, parseReply } from "./parse.ts";

type WorkshopRow = typeof workshops.$inferSelect;
type JobRow = typeof jobs.$inferSelect;

export class WorkshopError extends Error {}

export interface Broadcaster {
  broadcast(message: { type: "workshop_closed"; workshopId: number }): void;
}

export class Workshops implements WorkshopHooks {
  broadcaster: Broadcaster | null = null;

  constructor(
    private readonly db: Db,
    private readonly reposRoot: string,
    private readonly jobs: Jobs,
  ) {
    jobs.workshops = this;
  }

  get(id: number) {
    return this.db.select().from(workshops).where(eq(workshops.id, id)).get();
  }

  private activeJob(workshopId: number) {
    return this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.workshopId, workshopId), inArray(jobs.status, [...ACTIVE])))
      .get();
  }

  private addMessage(workshopId: number, role: "user" | "agent" | "system", body: string) {
    this.db.insert(workshopMessages).values({ workshopId, role, body }).run();
    this.db.update(workshops).set({ updatedAt: new Date() }).where(eq(workshops.id, workshopId)).run();
  }

  async create(projectId: number, user: User, body: { idea: string; bot: string; title?: string }) {
    const bot = this.db.select().from(users).where(eq(users.username, body.bot)).get();
    if (bot?.kind !== "bot" || !bot.agentType) throw new WorkshopError(`"${body.bot}" isn't an agent`);
    const project = this.db
      .select({ workspace: workspaces.slug, slug: projects.slug })
      .from(projects)
      .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
      .where(eq(projects.id, projectId))
      .get()!;
    const base = await defaultBranch(repoDir(this.reposRoot, project.workspace, project.slug));
    if (!base) throw new WorkshopError("Push at least one commit first, so the agent has code to read");

    const firstLine = body.idea.split("\n").find((l) => l.trim())!.trim();
    const title = body.title || (firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine);
    const row = this.db
      .insert(workshops)
      .values({ projectId, title, botId: bot.id, baseBranch: base, createdById: user.id })
      .returning()
      .get();
    this.addMessage(row.id, "user", body.idea);
    this.queue(row, "turn");
    return row;
  }

  // Queues the agent's next turn. Only one turn runs at a time.
  private queue(w: WorkshopRow, mode: "turn" | "finalize") {
    if (w.status !== "active") throw new WorkshopError("This workshop is over");
    if (this.activeJob(w.id)) throw new WorkshopError("The agent is still working on its reply");
    const bot = this.db.select().from(users).where(eq(users.id, w.botId)).get()!;
    const job = this.db
      .insert(jobs)
      .values({
        projectId: w.projectId,
        kind: "workshop",
        workshopId: w.id,
        workshopMode: mode,
        botId: w.botId,
        agentType: bot.agentType!,
        branch: "",
        baseBranch: w.baseBranch,
      })
      .returning()
      .get();
    this.jobs.logs.append(job.id, `Queued ${mode === "finalize" ? "the issue proposal" : "a workshop turn"} for ${bot.username}\n`);
    this.jobs.dispatcher?.dispatch();
    return job;
  }

  reply(w: WorkshopRow, body: string) {
    if (w.status !== "active") throw new WorkshopError("This workshop is over");
    if (this.activeJob(w.id)) throw new WorkshopError("The agent is still working on its reply");
    this.addMessage(w.id, "user", body);
    // A new answer invalidates any earlier proposal.
    this.db.update(workshops).set({ proposal: null }).where(eq(workshops.id, w.id)).run();
    return this.queue(this.get(w.id)!, "turn");
  }

  propose(w: WorkshopRow) {
    return this.queue(w, "finalize");
  }

  // Runs the last turn again, e.g. after it failed or was canceled.
  retry(job: JobRow) {
    const w = job.workshopId ? this.get(job.workshopId) : undefined;
    if (!w) throw new JobError("The workshop for this job no longer exists");
    try {
      return this.queue(w, job.workshopMode ?? "turn");
    } catch (e) {
      if (e instanceof WorkshopError) throw new JobError(e.message);
      throw e;
    }
  }

  close(w: WorkshopRow) {
    const active = this.activeJob(w.id);
    if (active) this.jobs.cancel(active);
    this.db.update(workshops).set({ status: "closed", updatedAt: new Date() }).where(eq(workshops.id, w.id)).run();
    this.broadcaster?.broadcast({ type: "workshop_closed", workshopId: w.id });
  }

  // --- Job hooks ----------------------------------------------------------------------------

  preferredRunner(job: JobRow) {
    const w = job.workshopId ? this.get(job.workshopId) : undefined;
    return w?.sessionRunnerId ?? null;
  }

  spec(job: JobRow): WorkshopTurn {
    const w = this.get(job.workshopId!)!;
    const transcript = this.db
      .select({ role: workshopMessages.role, body: workshopMessages.body })
      .from(workshopMessages)
      .where(eq(workshopMessages.workshopId, w.id))
      .orderBy(workshopMessages.id)
      .all();
    const lastUser = [...transcript].reverse().find((m) => m.role === "user");
    // Sessions live on the runner that created them.
    const sameRunner = w.sessionRunnerId !== null && w.sessionRunnerId === job.runnerId;
    return {
      id: w.id,
      title: w.title,
      mode: job.workshopMode ?? "turn",
      sessionId: sameRunner ? w.sessionId : null,
      transcript,
      message: lastUser?.body ?? "",
      plan: w.plan,
    };
  }

  async finished(job: JobRow, result: JobResult) {
    const w = this.get(job.workshopId!);
    if (!w) return;
    if (result.status === "canceled") {
      this.addMessage(w.id, "system", "The agent's turn was canceled.");
      return;
    }
    if (result.status === "failed") {
      this.addMessage(w.id, "system", `The agent's turn failed: ${result.error ?? "unknown error"}`);
      return;
    }

    const reply = parseReply(result.summary ?? "");
    this.addMessage(w.id, "agent", reply.message);
    const update: Partial<typeof workshops.$inferInsert> = { updatedAt: new Date() };
    if (reply.plan) update.plan = reply.plan;
    if (result.sessionId) {
      update.sessionId = result.sessionId;
      update.sessionRunnerId = job.runnerId;
    }
    if (job.workshopMode === "finalize") {
      if (reply.issues) update.proposal = JSON.stringify(reply.issues);
      else this.addMessage(w.id, "system", `The agent didn't propose a usable issue list${reply.issuesError ? ` (${reply.issuesError})` : ""}. Try proposing again.`);
    }
    this.db.update(workshops).set(update).where(eq(workshops.id, w.id)).run();
  }

  // --- Creating issues ----------------------------------------------------------------------

  createIssues(w: WorkshopRow, user: User, list: ProposedIssue[], withParent: boolean) {
    if (w.status !== "active") throw new WorkshopError("This workshop is over");
    if (this.activeJob(w.id)) throw new WorkshopError("Wait for the agent to finish its reply");
    let ordered: ProposedIssue[];
    try {
      ordered = orderIssues(list);
    } catch (e) {
      throw new WorkshopError(e instanceof Error ? e.message : String(e));
    }

    const footer = `\n\n---\n_From workshop #${w.id}: ${w.title}_`;
    const parent = withParent
      ? createIssue(this.db, w.projectId, user.id, {
          title: `Plan: ${w.title}`,
          body: `${w.plan || "_No plan was written._"}${footer}`,
          status: "todo",
          labels: ["plan"],
          parent: null,
          dependsOn: [],
          assignee: null,
        })
      : null;

    const numbers = new Map<string, number>();
    for (const issue of ordered) {
      const row = createIssue(this.db, w.projectId, user.id, {
        title: issue.title,
        body: `${issue.body}${footer}`,
        status: "todo",
        labels: issue.labels,
        parent: parent?.number ?? null,
        dependsOn: issue.dependsOn.map((key) => numbers.get(key)!),
        assignee: null,
      });
      numbers.set(issue.key, row.number);
    }
    // The plan's issue isn't done until its parts are.
    if (parent) updateIssue(this.db, parent, { dependsOn: [...numbers.values()] });

    this.db
      .update(workshops)
      .set({ status: "done", parentIssueId: parent?.id ?? null, proposal: JSON.stringify(list), updatedAt: new Date() })
      .where(eq(workshops.id, w.id))
      .run();
    this.broadcaster?.broadcast({ type: "workshop_closed", workshopId: w.id });
    return { parent: parent?.number ?? null, numbers: [...numbers.values()] };
  }

  // --- API shapes ---------------------------------------------------------------------------

  private projectPath(projectId: number) {
    const row = this.db
      .select({ workspace: workspaces.slug, project: projects.slug })
      .from(projects)
      .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
      .where(eq(projects.id, projectId))
      .get()!;
    return `${row.workspace}/${row.project}`;
  }

  summary(w: WorkshopRow): WorkshopSummary {
    const bot = this.db.select({ username: users.username }).from(users).where(eq(users.id, w.botId)).get();
    const messages = this.db.select({ id: workshopMessages.id }).from(workshopMessages).where(eq(workshopMessages.workshopId, w.id)).all().length;
    return {
      id: w.id,
      project: this.projectPath(w.projectId),
      title: w.title,
      status: w.status,
      bot: bot?.username ?? "",
      messages,
      waiting: this.activeJob(w.id) !== undefined,
      createdAt: w.createdAt.toISOString(),
      updatedAt: w.updatedAt.toISOString(),
    };
  }

  detail(w: WorkshopRow): WorkshopDetail {
    const messageList = this.db
      .select()
      .from(workshopMessages)
      .where(eq(workshopMessages.workshopId, w.id))
      .orderBy(workshopMessages.id)
      .all()
      .map((m) => ({ id: m.id, role: m.role, body: m.body, createdAt: m.createdAt.toISOString() }));
    const latestJob = this.db.select().from(jobs).where(eq(jobs.workshopId, w.id)).orderBy(desc(jobs.id)).get();
    const ref = (i: typeof issues.$inferSelect): IssueRef => ({ number: i.number, title: i.title, status: i.status });
    const parent = w.parentIssueId ? this.db.select().from(issues).where(eq(issues.id, w.parentIssueId)).get() : undefined;
    const created = parent
      ? this.db.select().from(issues).where(eq(issues.parentId, parent.id)).orderBy(issues.number).all().map(ref)
      : [];
    return {
      ...this.summary(w),
      baseBranch: w.baseBranch,
      plan: w.plan,
      proposal: w.proposal ? (JSON.parse(w.proposal) as ProposedIssue[]) : null,
      messageList,
      job: latestJob ? this.jobs.toApi(latestJob) : null,
      parentIssue: parent ? ref(parent) : null,
      createdIssues: created,
    };
  }

  list(projectId: number) {
    return this.db
      .select()
      .from(workshops)
      .where(eq(workshops.projectId, projectId))
      .orderBy(desc(workshops.updatedAt))
      .all()
      .map((w) => this.summary(w));
  }
}
