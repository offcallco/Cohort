import { EventEmitter } from "node:events";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_LOG_BYTES = 10 * 1024 * 1024;

// Job logs live in one file per job. Appends are also emitted as `log:<id>` events for
// live viewers; job status changes are emitted as `status:<id>`.
export class JobLogs extends EventEmitter {
  constructor(private readonly dir: string) {
    super();
    this.setMaxListeners(0);
    mkdirSync(dir, { recursive: true });
  }

  private file(jobId: number) {
    return join(this.dir, `job-${jobId}.log`);
  }

  append(jobId: number, text: string) {
    const file = this.file(jobId);
    try {
      const size = existsSync(file) ? statSync(file).size : 0;
      if (size >= MAX_LOG_BYTES) return;
      const chunk = size + text.length > MAX_LOG_BYTES ? `${text.slice(0, MAX_LOG_BYTES - size)}\n[log truncated]\n` : text;
      appendFileSync(file, chunk);
      this.emit(`log:${jobId}`, chunk);
    } catch (e) {
      // A log write failing (disk full, folder removed) must not take the job down with it.
      console.error(`Couldn't write the log for job ${jobId}: ${e instanceof Error ? e.message : e}`);
    }
  }

  // The last `bytes` of a job's log.
  tail(jobId: number, bytes = 64 * 1024) {
    const file = this.file(jobId);
    if (!existsSync(file)) return "";
    const size = statSync(file).size;
    if (size <= bytes) return readFileSync(file, "utf8");
    const fd = openSync(file, "r");
    try {
      const buffer = Buffer.alloc(bytes);
      readSync(fd, buffer, 0, bytes, size - bytes);
      // Drop the first, probably partial, line.
      return buffer.toString("utf8").replace(/^[^\n]*\n/, "");
    } finally {
      closeSync(fd);
    }
  }

  read(jobId: number) {
    const file = this.file(jobId);
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  }
}
