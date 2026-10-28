import { readFileSync } from "node:fs";
import WebSocket from "ws";
import type { JobSpec, RunnerMessage, ServerMessage } from "@cohort/shared";
import type { AgentAdapter } from "./agents/index.ts";
import type { RunnerConfig } from "./config.ts";
import { KeyedLock } from "./git.ts";
import { runImplementJob } from "./job.ts";
import { removeWorkshop, runWorkshopTurn } from "./workshop.ts";

const version = (JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string })
  .version;

const LOG_FLUSH_MS = 250;
const MAX_OUTBOX = 2000;

interface ActiveJob {
  spec: JobSpec;
  abort: AbortController;
  done: Promise<void>;
  buffer: string;
  timer: NodeJS.Timeout | null;
}

export interface ClientLogger {
  info(message: string): void;
  error(message: string): void;
}

// Keeps a WebSocket open to the Cohort server, runs the jobs it's assigned within the
// configured limits, and reconnects with backoff. Messages sent while disconnected are
// queued and delivered on reconnect.
export class RunnerClient {
  private socket: WebSocket | null = null;
  private readonly active = new Map<number, ActiveJob>();
  private readonly outbox: RunnerMessage[] = [];
  private readonly locks = new KeyedLock();
  private retryMs = 1000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly config: RunnerConfig,
    private readonly adapters: AgentAdapter[],
    private readonly logger: ClientLogger,
  ) {}

  start() {
    this.connect();
  }

  // Cancels running jobs, waits briefly for them to report, then disconnects.
  async stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const job of this.active.values()) job.abort.abort();
    await Promise.race([
      Promise.all([...this.active.values()].map((j) => j.done)),
      new Promise((r) => setTimeout(r, 10_000)),
    ]);
    this.socket?.close(1000, "Runner stopping");
  }

  private connect() {
    const wsUrl = `${this.config.url.replace(/^http/, "ws")}/api/runners/connect`;
    const socket = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${this.config.token}` } });
    this.socket = socket;

    socket.on("open", () => {
      this.retryMs = 1000;
      this.sendNow({
        type: "hello",
        version,
        concurrent: this.config.concurrent,
        agents: this.adapters.map((a) => ({ name: a.name, type: a.type, limit: this.limitFor(a) })),
        running: [...this.active.keys()],
      });
      for (const message of this.outbox.splice(0)) this.sendNow(message);
    });

    socket.on("message", (data) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(data)) as ServerMessage;
      } catch {
        return;
      }
      if (message.type === "welcome") this.logger.info(`Connected to ${this.config.url} as runner "${message.name}"`);
      else if (message.type === "assign") this.accept(message.job);
      else if (message.type === "cancel") this.active.get(message.jobId)?.abort.abort();
      else if (message.type === "workshop_closed") {
        void removeWorkshop(this.config.dataDir, message.workshopId, this.locks).catch(() => undefined);
      }
    });

    socket.on("unexpected-response", (_req, res) => {
      if (res.statusCode === 401) {
        this.logger.error("The server rejected this runner's token. Check `token` in the config file.");
        this.retryMs = 30_000;
      }
    });

    socket.on("error", () => {
      // "close" follows and handles reconnecting.
    });

    socket.on("close", (code) => {
      if (this.socket === socket) this.socket = null;
      if (this.stopped) return;
      if (code === 4001) {
        this.logger.error("This runner was deleted on the server. Stopping.");
        void this.stop();
        return;
      }
      const delay = this.retryMs;
      this.retryMs = Math.min(this.retryMs * 2, 30_000);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
  }

  private limitFor(adapter: AgentAdapter) {
    return this.config.agents.find((a) => a.name === adapter.name)?.limit ?? 1;
  }

  private send(message: RunnerMessage) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.sendNow(message);
      return;
    }
    this.outbox.push(message);
    // Drop the oldest log chunks first when the queue gets long.
    while (this.outbox.length > MAX_OUTBOX) {
      const index = this.outbox.findIndex((m) => m.type === "log");
      this.outbox.splice(index === -1 ? 0 : index, 1);
    }
  }

  private sendNow(message: RunnerMessage) {
    this.socket?.send(JSON.stringify(message));
  }

  private accept(spec: JobSpec) {
    const adapter = this.adapters.find((a) => a.type === spec.agent);
    if (!adapter) return this.send({ type: "rejected", jobId: spec.id, reason: `No ${spec.agent} agent on this runner` });
    const ofAgent = [...this.active.values()].filter((j) => j.spec.agent === spec.agent).length;
    if (this.active.size >= this.config.concurrent || ofAgent >= this.limitFor(adapter)) {
      return this.send({ type: "rejected", jobId: spec.id, reason: "Runner is at capacity" });
    }
    if (this.active.has(spec.id)) return;

    const abort = new AbortController();
    const job: ActiveJob = { spec, abort, buffer: "", timer: null, done: Promise.resolve() };
    this.active.set(spec.id, job);
    this.send({ type: "started", jobId: spec.id });
    const what = spec.workshop
      ? `workshop ${spec.workshop.id} (${spec.workshop.mode})`
      : spec.issue
        ? `#${spec.issue.number} ${spec.issue.title}`
        : spec.branch;
    this.logger.info(`Job ${spec.id}: ${what} (${adapter.name})`);

    const log = (text: string) => {
      job.buffer += text;
      job.timer ??= setTimeout(() => this.flush(job), LOG_FLUSH_MS);
    };

    const context = {
      serverUrl: this.config.url,
      dataDir: this.config.dataDir,
      instructions: this.config.context.instructions,
      adapter,
      signal: abort.signal,
      log,
      locks: this.locks,
    };
    const run = spec.kind === "workshop" ? runWorkshopTurn(spec, context) : runImplementJob(spec, context);
    job.done = run.then((outcome) => {
      this.flush(job);
      this.active.delete(spec.id);
      this.logger.info(`Job ${spec.id}: ${outcome.status}${outcome.error ? ` (${outcome.error})` : ""}`);
      this.send({ type: "finished", jobId: spec.id, ...outcome });
    });
  }

  private flush(job: ActiveJob) {
    if (job.timer) clearTimeout(job.timer);
    job.timer = null;
    if (!job.buffer) return;
    this.send({ type: "log", jobId: job.spec.id, text: job.buffer });
    job.buffer = "";
  }
}
