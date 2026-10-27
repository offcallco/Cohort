import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  // Root folder for everything Cohort stores: database, repos, runner data.
  home: string;
  host: string;
  port: number;
  // Extra hostnames the server will answer to, besides localhost.
  allowedHosts: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    home: env.COHORT_HOME ?? join(homedir(), ".cohort"),
    host: env.COHORT_HOST ?? "127.0.0.1",
    port: Number(env.COHORT_PORT ?? 7700),
    allowedHosts: (env.COHORT_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean),
  };
}

export const paths = (home: string) => ({
  db: join(home, "cohort.db"),
  repos: join(home, "repos"),
  runner: join(home, "runner"),
});

const rootPackage = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
) as { version: string };

export const version = rootPackage.version;
