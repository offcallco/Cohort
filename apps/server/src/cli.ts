import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "@cohort/db";
import { buildApp } from "./app.ts";
import { loadConfig, paths, version } from "./config.ts";
import { ensureLocalRunnerConfig, startLocalRunner } from "./localRunner.ts";

const webDir = fileURLToPath(new URL("../../web", import.meta.url));
const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
const sharedSrc = fileURLToPath(new URL("../../../packages/shared/src", import.meta.url));

// Newest modification time of any file under `dir`.
function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs);
  }
  return newest;
}

// The UI needs building when there's no build yet, or its sources (or the shared types it
// uses) changed since, e.g. after pulling a new version of Cohort.
function webBuildIsStale() {
  const built = join(webDist, "index.html");
  if (!existsSync(built)) return true;
  const sources = [join(webDir, "src"), join(webDir, "index.html"), join(webDir, "vite.config.ts"), sharedSrc];
  const newest = Math.max(...sources.map((s) => (statSync(s).isDirectory() ? newestMtime(s) : statSync(s).mtimeMs)));
  return newest > statSync(built).mtimeMs;
}

const usage = `Cohort ${version}

Usage: pnpm cohort <command>

Commands:
  start           Start the Cohort server
  start --dev     Start the API only (run the UI with \`pnpm dev\`)
  start --no-runner  Don't start the local runner
  help            Show this message

Environment:
  COHORT_HOME           Data folder (default ~/.cohort)
  COHORT_HOST           Address to listen on (default 127.0.0.1)
  COHORT_PORT           Port (default 7700)
  COHORT_ALLOWED_HOSTS  Extra comma-separated hostnames to accept
`;

async function start(dev: boolean, withRunner: boolean) {
  const config = loadConfig();
  const p = paths(config.home);
  for (const dir of [config.home, p.repos, p.runner]) mkdirSync(dir, { recursive: true });

  if (!dev && webBuildIsStale()) {
    console.log("Building the web UI...");
    const build = spawnSync("pnpm", ["build"], { cwd: webDir, stdio: "inherit" });
    if (build.status !== 0) process.exit(build.status ?? 1);
  }

  const { db, close } = openDb(p.db);
  const app = await buildApp({
    db,
    reposRoot: p.repos,
    logsDir: p.logs,
    webDist: dev ? undefined : webDist,
    allowedHosts: config.allowedHosts,
  });

  let runner: ReturnType<typeof startLocalRunner> | null = null;
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await runner?.stop();
    await app.close();
    close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ host: config.host, port: config.port });
  const shownHost = config.host === "127.0.0.1" ? "localhost" : config.host;
  console.log(`\nCohort ${version} is running`);
  console.log(`  ${dev ? "API" : "Open"}: http://${shownHost}:${config.port}`);
  console.log(`  Data: ${config.home}\n`);

  if (withRunner) {
    const host = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
    const configFile = ensureLocalRunnerConfig(db, p.runner, `http://${host}:${config.port}`);
    console.log(`Starting the local runner (${configFile})\n`);
    runner = startLocalRunner(configFile);
  }
}

const [command, ...flags] = process.argv.slice(2);
switch (command) {
  case "start":
    await start(flags.includes("--dev"), !flags.includes("--no-runner") && process.env.COHORT_RUNNER !== "off");
    break;
  case undefined:
  case "help":
  case "--help":
    console.log(usage);
    break;
  default:
    console.error(`Unknown command "${command}"\n`);
    console.log(usage);
    process.exit(1);
}
