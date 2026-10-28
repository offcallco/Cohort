# UI Design Guide — Agent-First Git Platform

## A Gitea replacement, not a Gitea clone

**Read this before touching any UI code. If a design choice conflicts with this doc, this doc wins
— do not silently revert to the old Gitea-style layout.**

> Cohort notes (decisions made with the project owner, which refine this guide):
> - **Light and dark.** The guide says dark-first; Cohort keeps both, following the system
>   setting. The dark palette below is the reference; the light palette mirrors its roles.
> - **Plan approval** applies to the root task a person assigns. Issues from a plan workshop were
>   already planned with the user and skip it. An agent's own decision to split a task into
>   sub-issues never needs approval by default.

### What this product is

A self-hosted git forge rebuilt around agents doing the whole loop end to end:

```
spec → plan → code → test → review → merge → deploy
```

Repos, branches, and diffs are still core. But the primary user job is **not** "browse a repo." It is:

> "Oversee a fleet of agents, see what each one changed, check the evidence, and approve or
> redirect it — fast, without reading raw logs."

If the UI looks like a repo browser with an agent feature bolted on, it has failed. If it looks
like a mission-control dashboard where repos are one input, it is on track.

### What this product is NOT

- Not a GitHub clone, not a GitLab clone, not a Gitea reskin.
- Not a chat app. The agent's chat/log is a detail view, never the home screen.
- Not a social feed. No stars feed, trending repos, or activity timeline as the default view.
- Not a settings-heavy admin panel. Settings exist, but they are not the product.

---

## 1. Design direction: Precision & Density

Pick this direction and commit to it everywhere. Do not mix in a second personality halfway through.

**Reference points to study, not copy pixel-for-pixel:**

- **Linear** — dark-first, quiet chrome, keyboard-first, dense but never crowded. Shows one level
  of detail at a time.
- **GitHub** — simple, approachable repo and PR flows. Steal its PR review clarity, not its clutter.
- **Vercel** — monochrome minimalism, restraint, clear observability. Less decoration, more hierarchy.
- **Antigravity / Cursor background agents** — a "Manager View" / mission control for parallel
  agents, separate from the editor view. Agents are visible, pausable, and reviewable from one
  dashboard.

**The feeling to aim for:** calm, fast, trustworthy. Like a control tower, not a terminal dump and
not a marketing site.

### Core principles

1. **One job per screen.** Every page answers one question in the first 5 seconds. If a page tries
   to answer three questions, split it.
2. **Quiet chrome, loud status.** The app frame should almost disappear. Color, contrast, and motion
   are reserved for things that need attention.
3. **Evidence before claims.** Never show "Done" without showing what changed and what passed. Every
   agent claim links to a diff, a test run, or a log line.
4. **Human gate, always visible.** On any agent-owned work, the human action (Approve / Request
   changes / Pause / Kill / Redirect) is never more than one click away, and never hidden in a menu.
5. **Summarize, then drill down.** Default view = 1-sentence summary + status + evidence count. Raw
   logs, full diffs, and tool calls are one click deeper, not the default.
6. **Density without clutter.** Power users live here for hours. Use compact rows, small type for
   metadata, and generous whitespace *between* groups — not a border around every single thing.
7. **Fast or it feels broken.** Optimistic updates, skeleton states (not blank pages), live status
   via polling/SSE without full-page reloads. No spinner with no phase label.

---

## 2. Visual system — use these tokens, do not invent new ones

Do not introduce a new button style, a new card style, or a new color per page. If you need a
variant that is not listed here, reuse the closest one and note it.

### Color

Dark-first. (Cohort: light mode mirrors these roles; see the note at the top.)

| Token | Value | Use |
|---|---|---|
| Background | `#0A0A0B` | App background |
| Panel | `#131316` / `#17171A` | Cards, side panels |
| Border | `#26262B` (low contrast) | Dividers, card borders. Borders should be subtle, not black boxes. |
| Text primary | `#FAFAFA` | Titles, code, primary content |
| Text secondary | `#A1A1AA` | Descriptions, metadata |
| Text muted | `#71717A` | Timestamps, counts, footnotes |
| Accent (only one) | `#818CF8` / indigo-400 | Primary actions, links, selected state. One accent only. |

**Status colors — the ONLY place color is allowed to shout. Always pair color with an icon + text
label, never color alone:**

| Status | Color | Icon |
|---|---|---|
| Running | Blue `#60A5FA` | Pulsing dot / spinner with phase label |
| Passed / Merged | Green `#34D399` | Check |
| Needs review / Waiting on you | Amber `#FBBF24` | Eye / clock — this is the highest-priority status in the UI |
| Failed / Blocked | Red `#F87171` | X |
| Paused / Idle / Draft | Gray `#A1A1AA` | Pause / dash |

Do NOT use: rainbow badges, gradient buttons, purple-to-blue gradients on cards,
red/green/yellow traffic-light decoration, or a different accent per feature.

### Typography

- **UI text:** Inter, Geist, or system sans. Clean, neutral, no personality font.
- **Code, paths, branch names, IDs, logs:** JetBrains Mono or equivalent monospace. Never render
  code in sans-serif.
- **Scale (do not freestyle sizes):**
  - Page title: 20px / semibold
  - Section title: 14px / semibold
  - Body: 14px / regular
  - Metadata / secondary: 12px / regular
  - Code: 13px / monospace
- Line height: 1.5 for body, 1.4 for metadata. Code line height 1.6.
- Never use text smaller than 12px for anything a user must act on.

### Spacing, radius, shadows

- Spacing scale only: 4, 8, 12, 16, 24, 32, 48px. No magic numbers like 7px, 13px, 19px.
- Radius: 6px for buttons/inputs, 8–10px for cards, 12px for modals. No pill buttons everywhere,
  no sharp 0px corners mixed with 16px cards.
- Shadows: subtle, almost flat. One soft shadow for dropdowns/modals only. Cards are separated by
  border + background, not heavy shadows.
- Group related items with whitespace, not with a border around every row.

### Buttons and controls

Exactly three button levels. No more.

1. **Primary:** solid accent background, dark text, for the one main action per view (e.g.
   Approve & Merge, Start run).
2. **Secondary:** bordered, panel background, for normal actions (View diff, Pause).
3. **Ghost / danger:** text-only or subtle border. Destructive actions (Kill run, Delete) are
   ghost-danger until confirmed — never a big red primary button by default.

- All interactive elements: minimum 32px height, visible focus ring, hover state that is a slight
  background change (not a color change).
- Disabled buttons must explain why on hover / in nearby text. Never a dead button with no reason.

---

## 3. App shell and navigation

Do NOT copy Gitea's structure (repo tabs everywhere, duplicated top nav + sidebar, every feature as
a top-level tab).

### Shell

```
┌─────────────┬──────────────────────────────────────────┐
│ Logo        │ [Context: Repo / Work item]   [Search ⌘K] │
│             │ [User avatar]                            │
├─────────────┼──────────────────────────────────────────┤
│ Mission     │                                          │
│ Control     │   PAGE CONTENT — one job, max-width      │
│ Repos       │   ~1100px for lists, full-width only for │
│ Work        │   diffs / code views                     │
│ Reviews     │                                          │
│ Agents      │                                          │
│ Activity    │                                          │
│ Settings    │                                          │
└─────────────┴──────────────────────────────────────────┘
```

- **Left nav, narrow and stable:** Mission Control, Repos, Work, Reviews, Agents, Activity,
  Settings. Icons + labels, not icons alone. Same order on every page.
- **Top bar, contextual only:** current repo / work item breadcrumb, global search (⌘K), user menu.
  Do not repeat the left nav in the top bar.
- **No second sidebar** inside a page unless it is a file tree or a review file list — and then it
  is clearly secondary (muted, collapsible).
- **Mobile / narrow:** left nav collapses to icons, diffs stack vertically, tables become cards.
  Test at 375px. A page that only works at 1440px is not done.

### Navigation IA — agent-first, not repo-first

| Route | Job — what the user learns in 5 seconds |
|---|---|
| Mission Control (home) | What needs me right now? What is running? What failed? |
| Repos | Find a repo, see its health, recent work, and open runs. |
| Work | All tasks / PRs across repos, filterable by status and owner (human vs agent). |
| Reviews | Only items waiting on a human. This is the inbox. Empty state = "Nothing needs you." |
| Agents | All agents/runs, their current phase, cost, and history. |
| Activity | Audit trail: who/what changed what, when. Not a social feed. |
| Settings | Repo, agent, and access settings. Boring on purpose. |

**Default landing page is Mission Control, not a repo list.** A returning user should see decisions
waiting, not a directory.

---

## 4. Page specs — build in this order

### Page 1: Mission Control (build this first)

This is the home screen and the best test of the whole design. If this page is ugly or confusing,
the rest will be too.

Layout, top to bottom:

1. **Needs you (top, cannot be missed):** up to 5 items waiting on a human — review, approval,
   blocked agent, failed check. Each row: title, repo, agent, what it needs, time waiting, one
   primary action. If none: clear empty state, "Nothing needs you. Agents are running clean." —
   not a blank page.
2. **Running now:** live agent runs. Each run card shows: agent name, task, current phase in plain
   English, elapsed time, files changed, tests so far. Not a log stream.
3. **Recent outcomes:** last 10 merged / failed / paused items, with status pill + evidence count
   (e.g. "12 files · 48 tests passed · 1 failed").

Rules:

- No more than 3–5 high-level numbers at the top. Example: Runs active, Needs review, Failed in
  last 24h. Not a wall of KPI cards.
- Every row is clickable to its Work detail page. No dead rows.
- Live updates do not jump the layout. Reserve space for status changes; do not re-sort the list
  every second while the user is reading it.

### Page 2: Work item / Task detail (the heart of the product)

One work item = one spec, executed by agents, gated by a human. This page must tell the whole story
without opening five tabs.

Structure:

1. **Header:** title, status pill, repo + branch, agent(s), created time, human owner.
2. **Pipeline / loop tracker (horizontal, always visible):**
   ```
   Spec ✓ → Plan ✓ → Code ● (in progress) → Test ○ → Review ○ → Merge ○ → Deploy ○
   ```
   Each step: done / current / pending / failed. Clicking a step jumps to its evidence.
3. **What changed (summary, not log):** files changed, lines +/-, linked PR/branch, and a 2–3 line
   agent summary in plain English. Example: "Added login rate limiting. 3 files changed. All new
   tests pass; 1 existing test was updated because the error message changed."
4. **Evidence / checks:** test results, lint, build — as a compact checklist with pass/fail per
   check, expandable to details. Never just "CI passed" with no breakdown.
5. **Human gate (sticky or prominent, not buried at the bottom):** Approve / Request changes (with
   a comment box) / Pause / Redirect agent / Kill run. Request changes must let the human write a
   short instruction the agent will act on — this is a core loop, not a comment graveyard.
6. **Timeline (collapsed by default, chronological):** plan approved, code pushed, tests run, review
   requested, human comment, agent fix. Each entry: time, actor (human vs agent name), what
   happened, link to evidence. No raw tool-call dump here.

### Page 3: Change review / Pull request

This is where trust is won or lost. Optimize for a reviewer who has 3 minutes.

- **Top:** title, author (agent name, clearly labeled as agent), branch → target, status, files
  changed, tests summary.
- **Agent summary first, diff second:** what the agent intended, what it actually changed, what it
  is unsure about, what tests it ran. The agent must state uncertainty explicitly — do not let it
  present a guess as a fact.
- **Diff viewer:** side-by-side on wide screens, unified/stacked on narrow. Syntax highlighting,
  monospace, line numbers, file tree on the left (collapsible), filter by file type, hide
  whitespace option, jump to next changed file. Comment on a line, not just on the whole PR.
- **Checks panel (right or below diff, not a separate tab):** each check with pass/fail, duration,
  link to log. A failed check must show the failing test name and error excerpt, not just "failed."
- **Merge gate:** merge button is disabled with a clear reason until: required checks pass AND
  (human approval OR auto-merge rule explicitly allows it). Show that reason in text next to the
  button.

### Page 4: Agent run detail

For when a human wants to dig in. Default is a summary, logs are a tab.

- **Header:** agent, task, phase, elapsed, cost/token estimate if available, branch/worktree.
- **Current step in one sentence:** e.g. "Running tests for auth module — 42/48 passed so far." Not
  "Thinking..." and not a spinner with no label.
- **Steps timeline:** plan → edit → test → fix → review, each with duration and outcome.
- **Artifacts:** plan doc, diff, test report, screenshots/preview if relevant. Artifacts are the
  deliverable — make them prominent, downloadable, and commentable.
- **Logs tab (secondary):** searchable, filterable by level, copyable lines, auto-scroll OFF by
  default when the user scrolls up. Never auto-scroll a user away from what they are reading.
- **Controls:** Pause, Resume, Redirect (new instruction), Kill. Killing requires one confirmation,
  and the confirmation states what will be preserved (branch, worktree, partial changes).

### Page 5: Repo home

Familiar, but cleaner than Gitea. Do not overload it.

- Header: repo name, one-line description, visibility, default branch, clone command (copy button),
  stars/forks only if they are real features — otherwise omit.
- README rendered cleanly, with good typography (not a wall of unstyled markdown).
- Below README: recent work (open tasks/PRs), recent runs, and a compact file browser. File browser:
  name, last commit message (truncated), time. No extra columns that nobody reads.
- Tabs, if any, are few: Code, Work, Runs, Settings. Not 12 tabs.

### Page 6: File browser / Code view

- Breadcrumb path, branch selector (prominent, not hidden), file list with clear icons by type.
- Code view: syntax highlighting, line numbers, copy path button, blame/history as secondary actions
  — not cluttering the main view.
- Search in repo (⌘K or /) is a first-class action, not buried in settings.

### Page 7: Reviews inbox and Work list

- These are lists, so make lists great: compact rows, status pill first, title second,
  repo/agent/time third. Sort and filter by: Needs me, Running, Failed, Merged, Mine, Agent-owned.
- Filters are visible chips, not a hidden advanced-search panel.
- Bulk actions only if they are safe and obvious. No bulk merge.

---

## 5. Components — build these once, reuse everywhere

| Component | Rules |
|---|---|
| Status pill | Icon + text + muted color background. Same pill everywhere. Never text-only status, never color-only status. |
| Run card | Agent, task (1 line), phase (1 sentence), progress (steps, not %), files/tests counts, primary human action. No card should contain a log excerpt. |
| Gate / checklist | Step name, status icon, evidence link, duration. Failed steps show the error excerpt inline. |
| Diff viewer | As in Page 3. No custom diff rendering that breaks syntax highlighting or line numbers. |
| Timeline | Time, actor, event, evidence link. Reverse chronological for activity, chronological for a run's steps — pick one per view and be consistent. |
| Empty state | One sentence explaining the state + one action. Example: "No runs yet. Create a task or connect a repo." Never a blank panel. |
| Loading state | Skeleton rows matching the final layout. Never a centered spinner on a blank page, never a layout jump when data arrives. |
| Error state | What failed, in plain English, + what to do next (Retry / View log / Contact). Never a stack trace as the main error UI. |
| Command palette (⌘K) | Search repos, work items, agents, and actions. Keyboard-first users should be able to navigate without a mouse. |

**Keyboard:** ⌘K search, `g` + `m` for Mission Control, `g` + `r` for Reviews, `j` / `k` or arrows
to move in lists, `Enter` to open, `Esc` to close. Document shortcuts in the palette itself. This
is a power tool — mouse-only is a bug, not a preference.

---

## 6. Agent-specific UX — the part Gitea never had to solve

These rules are what make this a Gitea *replacement* rather than a prettier Gitea.

1. **Always answer, on every agent surface:**
   - What is it doing right now? (1 sentence)
   - What has it changed? (files + diff link)
   - What is the evidence? (tests/checks, with counts)
   - What does it need from a human, if anything? (or: "Nothing — running clean")
   - How do I stop / redirect it? (Pause / Redirect / Kill, always visible)
2. **Show phases, not spinners.** "Planning", "Editing auth.py", "Running tests (42/48)",
   "Waiting for review" — never just "Loading..." or "Thinking..."
3. **Separate agent work from human work visually.** Agent-authored items are labeled "Agent:"
   everywhere — in lists, PR headers, commits, and comments. Never make it ambiguous whether a
   human or an agent wrote something.
4. **Plan approval is a real step.** Before an agent writes code on a non-trivial task, it submits a
   short plan. The human can approve, edit, or reject it in the UI. Do not let agents skip this
   silently.
5. **Intervention is a first-class action, not an error path.** Pausing, redirecting ("actually,
   use X instead of Y"), and killing a run should feel normal and safe, with a clear statement of
   what is preserved.
6. **Cost and time are visible, not hidden.** If available, show elapsed time and estimated
   cost/tokens on a run. Users should never be surprised by a run that has been looping for 2 hours.
7. **Do not stream raw thought / tool calls as the main UI.** Summarize first. A user should be able
   to approve a change without reading 500 lines of tool output. The full trace exists, one click
   away, for debugging.
8. **Uncertainty is a UI element.** If the agent is unsure, show it as "Agent is unsure about X —
   needs human input" with a prompt box, not as a confident-sounding summary.

---

## 7. What made the old UI feel ugly — do NOT repeat these

- **Do not** box everything. If every row, stat, and panel has a heavy border, nothing stands out.
  Use whitespace and one subtle border.
- **Do not** use a different button, badge, or tab style per page. One system, everywhere.
- **Do not** show 12 tabs, 8 stats, and 3 sidebars on one page. Pick the one job for that page.
- **Do not** use tiny gray-on-gray text for status, timestamps, or actions. If a user must act on
  it, it must be readable at a glance.
- **Do not** default to a log/terminal view. Logs are evidence, not the interface.
- **Do not** use color for decoration. If you add a colorful illustration, gradient, or rainbow tag
  "to make it pop," remove it.
- **Do not** copy Gitea's server-rendered, Fomantic-era patterns: inconsistent spacing, mixed button
  sizes, and dense tables with no hierarchy. The new UI should feel like Linear/GitHub in 2026, not
  a 2015 admin theme.
- **Do not** add features to the home screen to make it look "full." An empty Reviews inbox is a
  success state, not a problem to fill with widgets.

---

## 8. Accessibility and responsiveness — not optional

- Contrast: body text at least 4.5:1 against background. Status pills must pass with their text,
  not just their background.
- Focus: visible focus ring on every interactive element. Keyboard navigation must reach every
  action, including Approve / Pause / Kill.
- No color-only meaning: status always has icon + text.
- Motion: subtle only. No bouncing badges, no auto-playing animations. Respect
  `prefers-reduced-motion`.
- Responsive breakpoints to test: 1440px, 1024px, 768px, 375px. At 375px: nav collapses, diffs
  stack, tables become cards, human actions stay reachable without horizontal scrolling.
- Touch targets: at least 32px, ideally 40px for primary actions on mobile.

---

## 9. Implementation order for the coding agent

Do not try to redesign everything at once. Work in this order, and stop after each step to
screenshot and check against section 8's checklist:

1. **Tokens + shell:** colors, type, spacing, left nav, top bar, ⌘K placeholder. No pages yet.
   Screenshot the empty shell — it should already look calm.
2. **Mission Control + Run card:** needs-you list, running runs, recent outcomes. This is the demo
   page.
3. **Work detail + pipeline tracker + human gate:** the core loop.
4. **Review / PR diff + checks panel:** the trust page.
5. **Repo home + file browser / code view:** the familiar forge pages, cleaned up.
6. **Agent run detail + logs tab + artifacts:** the debugging page.
7. **Polish pass:** empty states, loading skeletons, error states, keyboard shortcuts, mobile
   widths. Do not call the UI done until every page has all four states designed: loading, empty,
   success, error.

**When you finish a page, do this self-check before moving on:**

- [ ] Can a new user tell what this page is for in 5 seconds?
- [ ] Can they tell what needs their attention, if anything, without scrolling?
- [ ] Is there exactly one primary action, and is it obvious?
- [ ] Does every agent claim link to evidence (diff/test/log)?
- [ ] Does it work with keyboard only?
- [ ] Does it look calm at 1440px AND usable at 375px?
- [ ] If you screenshot it next to Linear or GitHub, does it look like it belongs in the same era —
      not like a Gitea theme?

**If you are unsure between two designs, choose:** fewer elements, quieter chrome, clearer status,
and the version that shows evidence sooner. When in doubt, remove something.

---

## 10. Good copy examples — steal this tone

Agent status should sound like a competent teammate reporting in, not a system log:

- Good: "Writing tests for login rate limiting — 12 files changed, 42/48 tests passing."
- Bad: "Agent is running tool calls... [tool: edit_file, status: success]"
- Good: "Waiting for your review: plan for checkout refactor is ready."
- Bad: "Status: PENDING_REVIEW"
- Good: "Failed: 1 test in payments — `test_refund_partial` timed out after 30s. Log linked below."
- Bad: "Error occurred."

Use plain English, present tense, and specific nouns (file names, test names, counts). Never use
internal status codes as user-facing copy.
