import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CiJobSpec } from "@cohort/shared";
import { checkout, removeCheckout } from "./checkout.ts";
import type { KeyedLock } from "./git.ts";
import { runProcess } from "./process.ts";

export interface CiContext {
  serverUrl: string;
  dataDir: string;
  locks: KeyedLock;
  timeoutMinutes: number;
  signal: AbortSignal;
  log: (text: string) => void;
}

export interface CiOutcome {
  status: "succeeded" | "failed" | "canceled";
  error?: string;
}

// The job's script as one shell script: each command is echoed as "$ command" before it
// runs, and the first failing command ends the job (like GitLab's shell executor).
export function ciScript(commands: string[]) {
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return ["set -e", ...commands.flatMap((c) => [`printf '%s\\n' ${quote(`$ ${c.split("\n")[0]}${c.includes("\n") ? " …" : ""}`)}`, c])].join("\n");
}

// Runs a CI job in a fresh checkout of the pipeline's commit.
export async function runCiJob(job: CiJobSpec, ctx: CiContext): Promise<CiOutcome> {
  const dir = join(ctx.dataDir, "ci", `job-${job.id}`);
  const tmp = mkdtempSync(join(tmpdir(), "cohort-ci-"));
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), ctx.timeoutMinutes * 60_000);
  const signal = AbortSignal.any([ctx.signal, timeout.signal]);

  // The agent-style job spec fields checkout() needs.
  const target = { project: job.project, clonePath: job.clonePath, token: job.token } as Parameters<typeof checkout>[0];
  try {
    ctx.log(`Checking out ${job.ref} at ${job.sha.slice(0, 8)}\n`);
    try {
      await checkout(target, { serverUrl: ctx.serverUrl, dataDir: ctx.dataDir, locks: ctx.locks, dir, startPoint: job.sha, commit: true });
    } catch (e) {
      return { status: "failed", error: `Couldn't check out the commit: ${e instanceof Error ? e.message : e}` };
    }
    const scriptFile = join(tmp, "script.sh");
    writeFileSync(scriptFile, ciScript(job.script));

    const { code } = await runProcess("/bin/sh", [scriptFile], {
      cwd: dir,
      env: { ...process.env, ...job.variables },
      signal,
      onStdoutLine: (line) => ctx.log(`${line}\n`),
      onStderr: (text) => ctx.log(text),
    });
    if (ctx.signal.aborted) return { status: "canceled" };
    if (timeout.signal.aborted) return { status: "failed", error: `Timed out after ${ctx.timeoutMinutes} minutes` };
    return code === 0 ? { status: "succeeded" } : { status: "failed", error: `Script exited with code ${code}` };
  } finally {
    clearTimeout(timer);
    rmSync(tmp, { recursive: true, force: true });
    await removeCheckout({ dataDir: ctx.dataDir, locks: ctx.locks, project: job.project, dir });
  }
}
