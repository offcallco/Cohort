import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
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
    const size = existsSync(file) ? statSync(file).size : 0;
    if (size >= MAX_LOG_BYTES) return;
    const chunk = size + text.length > MAX_LOG_BYTES ? `${text.slice(0, MAX_LOG_BYTES - size)}\n[log truncated]\n` : text;
    appendFileSync(file, chunk);
    this.emit(`log:${jobId}`, chunk);
  }

  read(jobId: number) {
    const file = this.file(jobId);
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  }
}
