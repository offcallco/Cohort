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

Cohort keeps all its data in `~/.cohort/`: the SQLite database, your repos and runner files.

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
pnpm test         # server tests (needs git on PATH)
pnpm typecheck    # all packages
```

After changing `packages/db/src/schema.ts`, create a migration with
`pnpm --filter @cohort/db db:generate`. Migrations run automatically on start.

### Layout

```
apps/server     Fastify API and the `cohort` command
apps/web        React UI (Vite)
packages/db     SQLite schema and migrations (Drizzle)
packages/shared Request and response types shared by the server and UI
```
