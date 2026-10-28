# Cohort build plan

Cohort is a self-hosted, GitLab-style git platform where coding agents are first-class runners.
You host your own repos, cut issues, and a connected agent (Claude Code or Codex) picks them up,
splits them into subtasks, and opens a merge request for you to review. Before an issue exists, a
**plan workshop** interviews you about the idea and turns the answers into a plan and linked issues.

## Goals

- **Local-first.** Clone this repo, run a couple of commands, open the UI in a browser. No cloud
  account, no external database.
- **Own git.** Repos live on your machine and are cloned and pushed over HTTPS like any git host.
- **Agents as runners.** Assigning an issue to an agent starts the work. The agent never merges; it
  always opens an MR.
- **Workshop before work.** An interview that challenges vague ideas and produces a plan the agent
  can execute.

## Decisions

| Area | Decision |
|---|---|
| Audience | Single user, self-hosted on their own device |
| Distribution | `git clone` → `pnpm install` → `pnpm cohort start`; server binds to `localhost` by default |
| Storage | SQLite file plus bare repos, all under `~/.cohort/` (no database to install) |
| Git | Bare repos on disk, served over smart HTTP by delegating to `git http-backend` |
| Stack | TypeScript end to end |
| Workshop | Runs on the runner, so the agent can read the code while it interviews you |
| Workshop output | A plan doc plus proposed linked issues, created only after you approve them |
| Autonomy | Assigning an issue to an agent starts it immediately; the agent always opens an MR, never merges |
| Sandbox | One git worktree per job |
| Agents | Claude Code and Codex, behind a shared adapter interface |
| Splitting | The runner splits an issue into child issues and runs them in parallel within config limits |
| Merging | Subtasks merge into the parent issue's branch; one MR for the whole issue |
| Agent routing | Project default agent, overridable per issue or label; subtasks inherit |
| Split gate | Splits within config limits run automatically; larger ones pause for approval |
| No runner online | Workshops and jobs queue, and the UI shows that no runner is available |
| Extra behavior | Not built in (e.g. no automatic final review pass); users add it as runner context |
| Tests | GitLab-style CI pipelines from a file in the repo, shown on the MR (see below) |

## Architecture

```
apps/
  server/   Fastify: REST API, git smart HTTP, WebSocket hub (runners + browsers), serves the web build
  web/      React (Vite) single-page app
  runner/   Node CLI: config.toml, scheduler, worktrees, agent adapters, CI executor
packages/
  shared/   zod schemas for the runner and browser protocols, shared types
  db/       Drizzle schema + migrations (SQLite)
```

`pnpm cohort start` boots the server and, by default, a local runner registered to it, so a fresh
install works with no further setup. Additional runners on other machines can connect with a
registration token.

### Data on disk

```
~/.cohort/
  cohort.db         SQLite database
  repos/            bare repos: <workspace>/<project>.git
  runner/
    config.toml     runner limits and agents
    worktrees/      one checkout per job, removed when the job ends
```

### Data model

- `Workspace` → `Project` (one repo, default agent, runner context)
- `Issue`: title, body, status (`todo` · `in_progress` · `review` · `done` · `blocked`), parent
  issue, depends-on issues, agent override, labels
- `WorkshopSession`: project, messages, status, resulting plan doc, proposed issues
- `PlanDoc`: markdown, linked to its workshop and the issues cut from it
- `Runner`: name, token, online status, agents, capacity
- `Job`: kind (`workshop` · `split` · `implement` · `resolve_conflict` · `ci`), issue, runner,
  agent, branch, worktree, status, log
- `MergeRequest`: source and target branch, status, comments, pipeline status
- `Pipeline` / `PipelineJob`: commit, stage, status, log
- `AccessToken`: for git over HTTPS and the API

## Runner

The runner opens an outbound WebSocket to the server, so it works behind a home router and the
server never has to reach in. The same connection carries workshop turns, job assignments, log
streams and status updates.

### Config

Modeled on GitLab Runner's `config.toml`:

```toml
concurrent = 4              # max jobs at once on this runner, all agents combined

[[agents]]
name  = "claude"
type  = "claude-code"
limit = 3                   # max jobs at once for this agent

[[agents]]
name  = "codex"
type  = "codex"
limit = 2

[split]
max_subtasks = 6            # a split needing more than this pauses for approval
max_depth    = 1            # subtasks can't split again

[context]
# Extra instructions sent to every agent job on this runner
instructions = """
"""
```

### Agent adapters

Each agent implements one interface, so adding another CLI agent means adding one adapter:

```ts
interface AgentAdapter {
  plan(session: WorkshopTurn): AsyncIterable<AgentEvent>  // read-only, resumable session
  split(issue: IssueSpec): Promise<SubtaskPlan>           // proposes subtasks + dependencies
  implement(job: JobSpec): AsyncIterable<AgentEvent>      // edits files in the job's worktree
}
```

- **Claude Code:** headless mode, with `--resume` for workshop turns and plan permission mode for
  read-only planning.
- **Codex:** its non-interactive exec mode, the equivalent settings.

Exact flags are checked against each CLI's docs when the adapter is built.

### Runner context

What the agent is told on each job, in order:

1. The issue (and parent issue and plan doc, for subtasks)
2. Project runner context, set in the project's settings in the UI
3. Runner context from `[context]` in `config.toml`
4. Whatever the repo already provides (`CLAUDE.md`, `AGENTS.md`)

Behavior Cohort doesn't build in, such as "review the combined diff before opening the MR" or
"always add tests," goes here.

### Job flow for an issue

1. An issue is assigned to an agent → the server queues an `implement` job.
2. The runner creates the parent branch `cohort/<issue-id>` and runs a `split` job.
3. **One subtask:** implement directly on the parent branch.
   **Several:** create child issues with their dependencies. If the count is above
   `max_subtasks`, pause the parent issue for approval.
4. The scheduler starts each subtask whose dependencies are done, as long as `concurrent` and the
   agent's `limit` allow. Each subtask runs on its own branch and worktree, cut from the parent
   branch.
5. A finished subtask merges into the parent branch. On a conflict, queue a `resolve_conflict` job.
6. When every child is done, open one MR from the parent branch to the default branch.
7. You review, comment and merge in the UI. A child issue can be retried or cancelled on its own.

## Plan workshop

1. Start a workshop on a project and describe the idea.
2. Each message goes through the runner to the agent's read-only planning session. The agent reads
   the code, asks one question at a time, gives a recommended answer, and pushes back on vague
   answers.
3. The agent drafts the plan doc in a side panel and keeps it updated as the conversation goes.
4. Ending the workshop proposes linked issues with their dependencies. You edit or delete them,
   then approve, and they're created.
5. With no runner online, the workshop is queued and the UI shows that no runner is available.

## CI pipelines (GitLab-style)

GitLab handles tests through CI pipelines, not through the agent:

- A `.gitlab-ci.yml` file in the repo defines stages and jobs (`script:` commands).
- A pipeline runs on every push, including pushes to MR branches. GitLab Runner executes its jobs.
- The MR page shows the pipeline status.
- "Pipelines must succeed" is an optional per-project setting that blocks merging until the
  pipeline passes. It's off by default.

Cohort does the same:

- **Pipeline file:** a `.cohort-ci.yml` in the repo, holding a minimal subset of the GitLab format
  (`stages`, jobs with `stage` and `script`).
- **Execution:** the same runner runs `ci` jobs on push, including pushes to agent branches.
- **MR page:** shows the pipeline status. A "Pipelines must succeed" project setting is off by
  default.
- **No pipeline file:** no pipeline runs.
- **Agent jobs:** don't wait on CI unless runner context asks the agent to run tests.

## Phases

1. **Scaffold.** pnpm monorepo, SQLite + Drizzle, `pnpm cohort start`, local sign-in, access tokens.
2. **Git hosting.** Create repos, clone and push over HTTPS, browse files, commits and branches.
3. **Workspaces and issues.** Create issues, statuses, assignees, labels, dependencies.
4. **Runner, one job.** Registration, WebSocket protocol, worktrees, Claude Code and Codex
   adapters, log streaming, push a branch, open an MR. MR diff view, comments, merge.
   *First end-to-end milestone: an issue becomes a reviewed MR.*
5. **Plan workshop.** Interview UI, resumable read-only agent sessions, live plan doc, proposed
   linked issues, approval, offline queueing.
6. **Splitting and scheduling.** Split jobs, child issues, dependency scheduling, `concurrent` and
   `limit`, merging into the parent branch, conflict resolution jobs, approval gate.
7. **CI pipelines.** `.cohort-ci.yml`, pipeline runs on push, status on MRs, optional merge gate.

## Out of scope for v1

- Multiple users, roles and permissions
- Hosted or multi-tenant deployment
- Docker sandboxes (worktrees only; the sandbox stays behind an interface so it can be swapped)
- Agents merging their own work
