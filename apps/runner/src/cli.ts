import { createAdapter, type AgentAdapter } from "./agents/index.ts";
import { RunnerClient } from "./client.ts";
import { loadConfig } from "./config.ts";

const usage = `Usage: cohort-runner run --config <path to config.toml>`;

const args = process.argv.slice(2);
const configIndex = args.indexOf("--config");
const configPath = configIndex === -1 ? undefined : args[configIndex + 1];

if (args[0] !== "run" || !configPath) {
  console.log(usage);
  process.exit(args[0] === "run" ? 1 : 0);
}

const prefix = "[runner]";
const logger = {
  info: (m: string) => console.log(`${prefix} ${m}`),
  error: (m: string) => console.error(`${prefix} ${m}`),
};

let config;
try {
  config = loadConfig(configPath);
} catch (e) {
  logger.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

// Agents whose CLI isn't installed are left out; their jobs wait for another runner.
const adapters: AgentAdapter[] = [];
for (const agentConfig of config.agents) {
  const adapter = createAdapter(agentConfig);
  if (await adapter.available()) adapters.push(adapter);
  else logger.error(`Agent "${adapter.name}" (${adapter.type}) isn't available on this machine; skipping it`);
}
logger.info(
  adapters.length
    ? `Agents: ${adapters.map((a) => `${a.name} (${a.type})`).join(", ")}; up to ${config.concurrent} jobs at once`
    : "No agents available; this runner won't take jobs",
);

const client = new RunnerClient(config, adapters, logger);
client.start();

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  logger.info("Stopping");
  await client.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
