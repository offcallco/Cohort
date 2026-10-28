# Cohort

A self-hosted git platform where coding agents work as runners. Host your own repos, cut issues,
and let a connected agent (Claude Code or Codex) pick them up and open merge requests for you to
review. A plan workshop helps you turn an idea into a plan and issues before any work starts.

Cohort is in early development. See the build plan for what's coming.

## Quick start

Requires Node.js 22+, pnpm and git.

```sh
git clone https://github.com/offcallco/Cohort.git
cd Cohort
pnpm install
pnpm cohort start
```

Open http://localhost:7700 and create your account. The first start builds the web UI, which
takes a few seconds.

## Using git

Create a workspace and a project in the UI, then clone or push with the URL shown on the project
page, like `http://localhost:7700/my-workspace/my-project.git`. When git asks for credentials,
use any username and an access token (Settings → Access tokens) as the password. Your OS
credential helper remembers it after the first time.

## Plan workshops

Before cutting issues, workshop the idea with an agent (project → **Workshops** → New
workshop). The agent reads the project's code in a read-only checkout on a runner, asks you one
question at a time with its recommended answer, pushes back on vague answers, and keeps a plan
document up to date beside the chat. When the plan is solid, **Propose issues** asks it to
break the plan into small, ordered issues; edit or remove them, then create them. They're
linked by dependencies and, optionally, grouped under a "Plan" issue that holds the plan.

Claude Code workshops run in Claude's `plan` mode and resume the same session each turn.
Codex workshops run in its read-only sandbox with the conversation so far. If no runner can
take the turn, your message waits in the queue and the workshop says why.

## CI pipelines

Add a `.cohort-ci.yml` to a repo, in the same format as GitLab's `.gitlab-ci.yml` (a subset:
`stages`, `variables`, and jobs with `stage`, `script`, `variables` and `allow_failure`):

```yaml
stages: [build, test]

build:
  stage: build
  script:
    - npm ci

test:
  stage: test
  script:
    - npm test
```

Every push by a person starts a pipeline; merge requests show the pipeline for their latest
commit. Stages run in order, jobs within a stage run in parallel, and a failure skips the
later stages. Runners run CI jobs with a shell (`[ci]` in `config.toml`), with GitLab's usual
variables such as `CI_COMMIT_SHA` and `CI_COMMIT_REF_NAME`.

Pipelines for **agents' merge requests wait for you** to start them, since their jobs run
commands from the agent's changes on your machine. Project settings can run them
automatically, and can require a passing pipeline before merging.

## Agents

Assign an issue to **claude-bot** (Claude Code) or **codex-bot** (OpenAI Codex) and a runner
picks it up: it checks out a fresh git worktree, runs the agent on the issue, commits, pushes a
`cohort/<issue>-<title>` branch and opens a merge request. The issue moves to *In review* and the
bot comments with a summary. Merging the MR marks the issue done. Watch the live log from the
issue or the project's Jobs tab, and cancel or retry from there.

Agents respect issue dependencies: an issue waits in the queue until the issues it waits on are
done. Assigning a parent issue whose sub-issues you (or a workshop) created assigns all of them;
they run in dependency order, each with its own MR, and the parent is done when they are.

The agent's first step is a **plan**: its approach, the files it'll change, how it'll test, and
what it's unsure about. For a task you assign directly, the issue waits until you **Approve**,
**Request changes** (the agent revises the plan with your note) or **Reject** it. Issues from a
workshop were planned with you already, so they go straight on; so do sub-issues. Once there's
an MR, **Request changes** sends your note to the agent, which works on the same branch and
updates the MR. **Redirect** stops a running agent and starts it again with a new instruction.

While planning, the agent also decides whether the issue should be **split**. If it proposes
two or more sub-issues, they're created and worked on in parallel (within the runner's limits),
each on a branch cut from the issue's branch and merged back into it when done. A conflict
between parts gets a job of its own to resolve it. When every part is merged you get **one**
merge request for the whole issue. Splits don't need approval unless the runner sets
`require_approval = true`, which holds splits bigger than `max_subtasks`. Label an issue
`no-split` to skip planning and splitting and go straight to code.

`pnpm cohort start` also starts a runner on this machine, configured in
`~/.cohort/runner/config.toml`:

```toml
concurrent = 2                    # jobs at once, all agents combined

[[agents]]
name = "claude"
type = "claude-code"              # needs the `claude` CLI
limit = 2                         # jobs at once for this agent
permission_mode = "acceptEdits"   # edit files only; "bypassPermissions" lets it run commands too

[[agents]]
name = "codex"
type = "codex"                    # needs the `codex` CLI
limit = 2

[split]
max_subtasks = 4                  # bigger splits wait for your approval
max_depth = 1                     # 0 turns splitting off

[ci]
enabled = true                    # run CI jobs from .cohort-ci.yml
timeout_minutes = 60

[context]
instructions = """Extra instructions for every job on this runner."""
```

Agents whose CLI isn't installed are skipped, and their issues wait in the queue with a note
saying no runner can take them. Each project also has a *Runner context* setting (project →
Settings) that's added to every job's instructions.

To run agents on another machine, create a runner under **Runners**, save the config it shows,
and run `pnpm runner run --config config.toml` from a clone of Cohort. Use
`pnpm cohort start --no-runner` to skip the local one.

Cohort keeps all its data in `~/.cohort/`: the SQLite database, your repos, job logs and
runner files.

## Configuration

Set these environment variables before `pnpm cohort start`:

| Variable | Default | Purpose |
|---|---|---|
| `COHORT_HOME` | `~/.cohort` | Data folder |
| `COHORT_HOST` | `127.0.0.1` | Address to listen on. Keep the default unless you trust your network |
| `COHORT_PORT` | `7700` | Port |
| `COHORT_ALLOWED_HOSTS` | | Extra comma-separated hostnames to accept, e.g. a LAN name |

## Development

```sh
pnpm dev          # API on :7700 and the UI with hot reload on http://localhost:5173
pnpm test         # server and runner tests (needs git on PATH)
pnpm typecheck    # all packages
```

After changing `packages/db/src/schema.ts`, create a migration with
`pnpm --filter @cohort/db db:generate`. Migrations run automatically on start.

### Layout

```
apps/server     Fastify API and the `cohort` command
apps/web        React UI (Vite)
apps/runner     Agent runner: WebSocket client, worktrees, Claude Code and Codex adapters
packages/db     SQLite schema and migrations (Drizzle)
packages/shared Request/response types and the runner protocol
```
