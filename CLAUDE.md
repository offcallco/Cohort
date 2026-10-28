# Cohort

A self-hosted, agent-first git platform. See `README.md` for running it and `docs/PLAN.md` for
the architecture and build plan.

## UI work

Read `docs/UI_GUIDE.md` before changing anything in `apps/web`. It defines the design system
(tokens, type scale, three button levels, status pills), the app shell and navigation, and the
page specs. If a design choice conflicts with the guide, the guide wins. Check pages with
`pnpm ui:preview`, which screenshots them at 1440px and 375px in light and dark.

## Checks

`pnpm typecheck` and `pnpm test` must pass. Tests need `git` on PATH.
