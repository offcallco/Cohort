import type { WebSocket } from "ws";
import { and, asc, eq } from "drizzle-orm";
import { jobs, pipelineJobs, projects, runners, users, type Db } from "@cohort/db";
import { runnerMessage, type AgentInfo, type RunnerMessage, type ServerMessage } from "@cohort/shared";
import { randomToken, sha256 } from "../auth.ts";
import type { Dispatcher, Jobs } from "../jobs/service.ts";
import { CI_TOKEN_PREFIX, type CiDispatcher, type Pipelines } from "../pipelines/service.ts";

type JobRow = typeof jobs.$inferSelect;

export const JOB_TOKEN_PREFIX = "cohort_job_";
export const RUNNER_TOKEN_PREFIX = "cohort_runner_";

interface Connection {
  runnerId: number;
  name: string;
  socket: WebSocket;
  concurrent: number;
  agents: AgentInfo[];
  // Jobs this runner is working on.
  running: Map<number, JobRow["agentType"]>;
  // Whether it takes CI jobs, and the CI jobs it's running. They share `concurrent`.
  ci: boolean;
  runningCi: Set<number>;
}

const busy = (conn: Connection) => conn.running.size + conn.runningCi.size;

export interface HubOptions {
  // How long a runner may stay disconnected before its running jobs fail.
  graceMs?: number;
}

export class RunnerHub implements Dispatcher, CiDispatcher {
  private readonly connections = new Map<number, Connection>();
  private readonly lostTimers = new Map<number, NodeJS.Timeout>();
  private readonly graceMs: number;
  private dispatching = false;
  // Set on shutdown; late socket events must not touch the (soon closed) database.
  private stopped = false;
  private redispatch = false;

  constructor(
    private readonly db: Db,
    private readonly jobs: Jobs,
    private readonly pipelines: Pipelines,
    options: HubOptions = {},
  ) {
    this.graceMs = options.graceMs ?? 60_000;
    jobs.dispatcher = this;
    pipelines.dispatcher = this;
  }

  // After a server restart, jobs left "running" fail unless their runner reconnects in time.
  start() {
    const orphaned = [
      ...this.db.select({ runnerId: jobs.runnerId }).from(jobs).where(eq(jobs.status, "running")).all(),
      ...this.db.select({ runnerId: pipelineJobs.runnerId }).from(pipelineJobs).where(eq(pipelineJobs.status, "running")).all(),
    ];
    for (const runnerId of new Set(orphaned.map((j) => j.runnerId))) this.scheduleLost(runnerId);
  }

  stop() {
    this.stopped = true;
    for (const timer of this.lostTimers.values()) clearTimeout(timer);
    for (const conn of this.connections.values()) conn.socket.close(1001, "Server shutting down");
  }

  disconnect(runnerId: number) {
    this.connections.get(runnerId)?.socket.close(4001, "Runner deleted");
  }

  isOnline(runnerId: number) {
    return this.connections.has(runnerId);
  }

  info(runnerId: number) {
    const conn = this.connections.get(runnerId);
    return conn ? { agents: conn.agents, concurrent: conn.concurrent, running: busy(conn), ci: conn.ci } : null;
  }

  availableAgentTypes() {
    return new Set([...this.connections.values()].flatMap((c) => c.agents.map((a) => a.type)));
  }

  waitingReason(agentType: JobRow["agentType"]) {
    if (!this.availableAgentTypes().has(agentType)) return `No runner with ${agentType} is online`;
    return "Waiting for a free slot on a runner";
  }

  // --- Connections --------------------------------------------------------------------------

  // `runnerId` comes from the token the runner authenticated with.
  attach(socket: WebSocket, runner: { id: number; name: string }) {
    let conn: Connection | null = null;

    socket.on("message", (data) => {
      if (this.stopped) return;
      let message: RunnerMessage;
      try {
        message = runnerMessage.parse(JSON.parse(String(data)));
      } catch {
        socket.close(1008, "Invalid message");
        return;
      }
      if (message.type === "hello") {
        // A second connection with the same token replaces the first.
        this.connections.get(runner.id)?.socket.close(4000, "Replaced by a new connection");
        conn = {
          runnerId: runner.id,
          name: runner.name,
          socket,
          concurrent: message.concurrent,
          agents: message.agents,
          running: new Map(),
          ci: message.ci,
          runningCi: new Set(),
        };
        this.connections.set(runner.id, conn);
        this.clearLost(runner.id);
        this.reconcile(conn, message.running, message.runningCi);
        this.touch(runner.id);
        this.send(conn, { type: "welcome", runnerId: runner.id, name: runner.name });
        this.dispatch();
        return;
      }
      if (!conn) return;
      void this.handle(conn, message);
    });

    socket.on("close", () => {
      if (this.stopped) return;
      if (conn && this.connections.get(runner.id) === conn) {
        this.connections.delete(runner.id);
        this.touch(runner.id);
        if (busy(conn) > 0) this.scheduleLost(runner.id);
      }
    });
  }

  private async handle(conn: Connection, message: Exclude<RunnerMessage, { type: "hello" }>) {
    if (message.ci) return this.handleCi(conn, message);
    const owned = conn.running.has(message.jobId);
    if (!owned) return;
    switch (message.type) {
      case "started":
        this.jobs.log(message.jobId, "Runner started the job\n");
        break;
      case "log":
        this.jobs.log(message.jobId, message.text);
        break;
      case "rejected":
        conn.running.delete(message.jobId);
        this.jobs.requeue(message.jobId, message.reason);
        // Avoid handing the same job straight back to the runner that refused it.
        setTimeout(() => this.dispatch(), 1000);
        break;
      case "finished":
        conn.running.delete(message.jobId);
        await this.jobs.finish(message.jobId, message);
        break;
    }
  }

  private handleCi(conn: Connection, message: Exclude<RunnerMessage, { type: "hello" }>) {
    if (!conn.runningCi.has(message.jobId)) return;
    switch (message.type) {
      case "started":
        break;
      case "log":
        this.pipelines.log(message.jobId, message.text);
        break;
      case "rejected":
        conn.runningCi.delete(message.jobId);
        this.pipelines.requeue(message.jobId, message.reason);
        setTimeout(() => this.dispatch(), 1000);
        break;
      case "finished":
        conn.runningCi.delete(message.jobId);
        this.pipelines.finished(message.jobId, message);
        break;
    }
  }

  // Jobs the database thinks this runner has but the runner doesn't know about are lost.
  private reconcile(conn: Connection, stillRunning: number[], stillRunningCi: number[]) {
    for (const job of this.pipelines.runningOn(conn.runnerId)) {
      if (stillRunningCi.includes(job.id)) conn.runningCi.add(job.id);
      else this.pipelines.finished(job.id, { status: "failed", error: "The runner restarted and lost this job" });
    }
    const rows = this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.runnerId, conn.runnerId), eq(jobs.status, "running")))
      .all();
    for (const job of rows) {
      if (stillRunning.includes(job.id)) conn.running.set(job.id, job.agentType);
      else void this.jobs.finish(job.id, { status: "failed", error: "The runner restarted and lost this job" });
    }
  }

  private scheduleLost(runnerId: number | null) {
    const key = runnerId ?? 0;
    this.clearLost(key);
    this.lostTimers.set(
      key,
      setTimeout(() => {
        this.lostTimers.delete(key);
        if (runnerId !== null && this.connections.has(runnerId)) return;
        const where = runnerId === null
          ? and(eq(jobs.status, "running"))
          : and(eq(jobs.status, "running"), eq(jobs.runnerId, runnerId));
        for (const job of this.db.select().from(jobs).where(where).all()) {
          if (job.runnerId !== null && this.connections.has(job.runnerId)) continue;
          void this.jobs.finish(job.id, { status: "failed", error: "Lost contact with the runner" });
        }
        const ciWhere = runnerId === null
          ? eq(pipelineJobs.status, "running")
          : and(eq(pipelineJobs.status, "running"), eq(pipelineJobs.runnerId, runnerId));
        for (const job of this.db.select().from(pipelineJobs).where(ciWhere).all()) {
          if (job.runnerId !== null && this.connections.has(job.runnerId)) continue;
          this.pipelines.finished(job.id, { status: "failed", error: "Lost contact with the runner" });
        }
      }, this.graceMs),
    );
  }

  private clearLost(key: number) {
    const timer = this.lostTimers.get(key);
    if (timer) clearTimeout(timer);
    this.lostTimers.delete(key);
  }

  private touch(runnerId: number) {
    this.db.update(runners).set({ lastSeenAt: new Date() }).where(eq(runners.id, runnerId)).run();
  }

  private send(conn: Connection, message: ServerMessage) {
    conn.socket.send(JSON.stringify(message));
  }

  // --- Scheduling ---------------------------------------------------------------------------

  // Hands queued jobs, oldest first, to runners with a free slot for the job's agent.
  dispatch() {
    if (this.dispatching) {
      this.redispatch = true;
      return;
    }
    this.dispatching = true;
    void this.runDispatch().finally(() => {
      this.dispatching = false;
      if (this.redispatch) {
        this.redispatch = false;
        this.dispatch();
      }
    });
  }

  private async runDispatch() {
    const queued = this.db.select().from(jobs).where(eq(jobs.status, "queued")).orderBy(asc(jobs.id)).all();
    for (const job of queued) {
      if (this.jobs.blockedReason(job)) continue;
      const conn = this.pickRunner(job.agentType, this.jobs.preferredRunner(job));
      if (!conn) continue;
      const token = JOB_TOKEN_PREFIX + randomToken();
      // Build the spec first (it depends on the runner, e.g. for workshop sessions). Then mark
      // the job assigned and send it in one step, so a cancel can never reach the runner
      // before the job it cancels.
      const draft = { ...job, runnerId: conn.runnerId };
      const spec = this.jobs.spec(draft, token);
      spec.branchExists = await this.jobs.branchExists(draft);
      if (!this.connections.has(conn.runnerId) || this.jobs.get(job.id)?.status !== "queued") continue;
      conn.running.set(job.id, job.agentType);
      this.jobs.assigned(job.id, conn.runnerId, sha256(token));
      this.send(conn, { type: "assign", job: spec });
    }

    for (const job of this.pipelines.pendingJobs()) {
      const conn = this.pickCiRunner();
      if (!conn) break;
      const token = CI_TOKEN_PREFIX + randomToken();
      conn.runningCi.add(job.id);
      this.pipelines.assigned(job.id, conn.runnerId, token);
      this.send(conn, { type: "assign_ci", job: this.pipelines.spec(this.pipelines.getJob(job.id)!, token) });
    }
  }

  private pickCiRunner(): Connection | null {
    let best: Connection | null = null;
    for (const conn of this.connections.values()) {
      if (!conn.ci || busy(conn) >= conn.concurrent) continue;
      if (!best || busy(conn) < busy(best)) best = conn;
    }
    return best;
  }

  ciWaitingReason() {
    if (![...this.connections.values()].some((c) => c.ci)) return "No runner that takes CI jobs is online";
    return "Waiting for a free slot on a runner";
  }

  cancelCi(job: typeof pipelineJobs.$inferSelect): boolean {
    const conn = job.runnerId !== null ? this.connections.get(job.runnerId) : undefined;
    if (!conn || !conn.runningCi.has(job.id)) return false;
    this.pipelines.log(job.id, "Cancel requested\n");
    this.send(conn, { type: "cancel_ci", jobId: job.id });
    return true;
  }

  // Least busy runner with a free slot for `agentType`, or `preferred` when it has one
  // (workshop turns go back to the runner holding the agent's session).
  private pickRunner(agentType: JobRow["agentType"], preferred: number | null = null): Connection | null {
    let best: Connection | null = null;
    for (const conn of this.connections.values()) {
      const agent = conn.agents.find((a) => a.type === agentType);
      if (!agent) continue;
      const ofAgent = [...conn.running.values()].filter((t) => t === agentType).length;
      if (busy(conn) >= conn.concurrent || ofAgent >= agent.limit) continue;
      if (conn.runnerId === preferred) return conn;
      if (!best || busy(conn) < busy(best)) best = conn;
    }
    return best;
  }

  setPaused(job: JobRow, paused: boolean): boolean {
    const conn = job.runnerId !== null ? this.connections.get(job.runnerId) : undefined;
    if (!conn || !conn.running.has(job.id)) return false;
    this.send(conn, { type: paused ? "pause" : "resume", jobId: job.id });
    return true;
  }

  broadcast(message: ServerMessage) {
    for (const conn of this.connections.values()) this.send(conn, message);
  }

  cancel(job: JobRow): boolean {
    const conn = job.runnerId !== null ? this.connections.get(job.runnerId) : undefined;
    if (!conn || !conn.running.has(job.id)) return false;
    this.jobs.log(job.id, "Cancel requested\n");
    this.send(conn, { type: "cancel", jobId: job.id });
    return true;
  }
}

// Resolves a job token to the bot it acts as, if the job is running on `projectId`.
export function userForJobToken(db: Db, token: string, projectId: number) {
  if (!token.startsWith(JOB_TOKEN_PREFIX)) return null;
  const row = db
    .select({ id: users.id, username: users.username, kind: users.kind })
    .from(jobs)
    .innerJoin(users, eq(users.id, jobs.botId))
    .innerJoin(projects, eq(projects.id, jobs.projectId))
    .where(and(eq(jobs.tokenHash, sha256(token)), eq(jobs.status, "running"), eq(jobs.projectId, projectId)))
    .get();
  return row ?? null;
}

export function runnerForToken(db: Db, token: string) {
  if (!token.startsWith(RUNNER_TOKEN_PREFIX)) return null;
  return db.select().from(runners).where(eq(runners.tokenHash, sha256(token))).get() ?? null;
}

