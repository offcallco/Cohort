import { parse } from "yaml";

export const CI_CONFIG_FILE = ".cohort-ci.yml";

// GitLab's defaults when `stages` is left out.
const DEFAULT_STAGES = ["build", "test", "deploy"];
const RESERVED_KEYS = new Set(["stages", "variables", "default", "workflow", "include", "image", "services", "cache", "before_script", "after_script"]);
const MAX_JOBS = 50;

export interface CiJobDefinition {
  name: string;
  stage: string;
  stageIndex: number;
  script: string[];
  variables: Record<string, string>;
  allowFailure: boolean;
}

export class CiConfigError extends Error {}

function stringMap(value: unknown, where: string): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new CiConfigError(`${where} must be a map of names to values`);
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new CiConfigError(`${where}: "${key}" isn't a valid variable name`);
    if (typeof v === "object" && v !== null) throw new CiConfigError(`${where}: "${key}" must be a string or number`);
    out[key] = String(v ?? "");
  }
  return out;
}

// Reads the subset of GitLab CI syntax Cohort supports: `stages`, top-level `variables`, and
// jobs with `stage`, `script`, `variables` and `allow_failure`. Keys starting with "." are
// hidden jobs (templates) and are skipped, like in GitLab.
export function parseCiConfig(text: string): { stages: string[]; jobs: CiJobDefinition[] } {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (e) {
    throw new CiConfigError(`${CI_CONFIG_FILE} isn't valid YAML: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw new CiConfigError(`${CI_CONFIG_FILE} must be a map of jobs`);
  const root = doc as Record<string, unknown>;

  let stages = DEFAULT_STAGES;
  if (root.stages !== undefined) {
    if (!Array.isArray(root.stages) || !root.stages.every((s) => typeof s === "string") || root.stages.length === 0) {
      throw new CiConfigError("stages must be a list of names");
    }
    stages = root.stages as string[];
  }
  const globalVariables = stringMap(root.variables, "variables");

  const jobs: CiJobDefinition[] = [];
  for (const [name, value] of Object.entries(root)) {
    if (RESERVED_KEYS.has(name) || name.startsWith(".")) continue;
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CiConfigError(`Job "${name}" must be a map`);
    const job = value as Record<string, unknown>;
    const script = typeof job.script === "string" ? [job.script] : job.script;
    if (!Array.isArray(script) || script.length === 0 || !script.every((s) => typeof s === "string")) {
      throw new CiConfigError(`Job "${name}" needs a script: a command or a list of commands`);
    }
    const stage = job.stage === undefined ? "test" : job.stage;
    if (typeof stage !== "string") throw new CiConfigError(`Job "${name}": stage must be a name`);
    const stageIndex = stages.indexOf(stage);
    if (stageIndex === -1) throw new CiConfigError(`Job "${name}" uses stage "${stage}", which isn't in stages (${stages.join(", ")})`);
    if (job.allow_failure !== undefined && typeof job.allow_failure !== "boolean") {
      throw new CiConfigError(`Job "${name}": allow_failure must be true or false`);
    }
    jobs.push({
      name,
      stage,
      stageIndex,
      script: script as string[],
      variables: { ...globalVariables, ...stringMap(job.variables, `Job "${name}" variables`) },
      allowFailure: job.allow_failure === true,
    });
  }
  if (jobs.length === 0) throw new CiConfigError(`${CI_CONFIG_FILE} has no jobs`);
  if (jobs.length > MAX_JOBS) throw new CiConfigError(`${CI_CONFIG_FILE} has more than ${MAX_JOBS} jobs`);
  return { stages: stages.filter((s) => jobs.some((j) => j.stage === s)), jobs };
}
