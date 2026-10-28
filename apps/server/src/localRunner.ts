import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "@cohort/db";
import { runnerForToken } from "./runners/hub.ts";
import { createRunner } from "./routes/runners.ts";

const runnerCli = fileURLToPath(new URL("../../runner/src/cli.ts", import.meta.url));

const template = (url: string, token: string) => `# Cohort runner on this machine. Edit agents and limits, then restart Cohort.
url = "${url}"
token = "${token}"

# Max jobs at once on this runner, all agents combined.
concurrent = 2

# Used for issues assigned to claude-bot.
[[agents]]
name = "claude"
type = "claude-code"
limit = 2
# "acceptEdits" lets Claude edit files but not run commands. Use "bypassPermissions" to let
# it run anything your user account can.
permission_mode = "acceptEdits"

# Used for issues assigned to codex-bot.
[[agents]]
name = "codex"
type = "codex"
limit = 2

# Big issues can be split into sub-issues that run in parallel and merge into one branch.
[split]
# A split into more sub-issues than this waits for your approval.
max_subtasks = 4
# 0 turns splitting off; 1 lets issues split once.
max_depth = 1

# CI jobs from each repo's .cohort-ci.yml. They run shell commands from the repo on this
# machine. Pipelines for agents' changes wait until you start them (see project settings).
[ci]
enabled = true
timeout_minutes = 60

[context]
# Extra instructions sent with every job on this runner.
instructions = """
"""
`;

// Makes sure ~/.cohort/runner/config.toml exists, points at this server and has a valid token.
export function ensureLocalRunnerConfig(db: Db, runnerDir: string, url: string) {
  const file = join(runnerDir, "config.toml");
  if (!existsSync(file)) {
    const { token } = createRunner(db, "local");
    writeFileSync(file, template(url, token), { mode: 0o600 });
    return file;
  }
  let text = readFileSync(file, "utf8");
  const token = text.match(/^token\s*=\s*"([^"]*)"/m)?.[1];
  if (!token || !runnerForToken(db, token)) {
    // The database was reset or the runner deleted: register again.
    const fresh = createRunner(db, "local").token;
    text = /^token\s*=/m.test(text) ? text.replace(/^token\s*=.*$/m, `token = "${fresh}"`) : `token = "${fresh}"\n${text}`;
  }
  text = text.replace(/^url\s*=.*$/m, `url = "${url}"`);
  writeFileSync(file, text, { mode: 0o600 });
  return file;
}

// Runs the runner as a child process, restarting it if it exits unexpectedly.
export function startLocalRunner(configFile: string) {
  let child: ChildProcess | null = null;
  let stopped = false;
  let delay = 1000;

  const launch = () => {
    // Same Node and loader flags (tsx) as this process.
    child = spawn(process.execPath, [...process.execArgv, runnerCli, "run", "--config", configFile], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    const startedAt = Date.now();
    child.on("exit", (code, signal) => {
      child = null;
      if (stopped) return;
      if (Date.now() - startedAt > 60_000) delay = 1000;
      console.error(`[runner] exited (${signal ?? code}); restarting in ${delay / 1000}s`);
      setTimeout(launch, delay);
      delay = Math.min(delay * 2, 60_000);
    });
  };
  launch();

  return {
    stop: () =>
      new Promise<void>((resolve) => {
        stopped = true;
        if (!child) return resolve();
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
        setTimeout(() => {
          child?.kill("SIGKILL");
          resolve();
        }, 15_000);
      }),
  };
}
