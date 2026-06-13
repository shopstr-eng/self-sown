---
name: Jest cold compile exceeds the 120s tool window
description: Constraint — next/jest cold compile can't start within a single bash tool call here; testcontainer DB tests are effectively unrunnable from the agent.
---

Running `jest` (via `next/jest`) in this repo cold-starts so slowly that it does
not produce output within a single bash tool call (max 120s). This is NOT
specific to Testcontainers — even a tiny mocked unit test (e.g.
`utils/db/__tests__/lifetime-grant-sql.test.ts`) fails to start in time.

**Why:** `next/jest` loads next config + SWC and compiles the whole graph under
heavy memory pressure (persistent tsserver/LSP eat RAM; see
`upstream-parity-and-dev-oom.md`). Detached `setsid` runs survive across tool
calls but get memory-starved and die during compile before any container starts
(raising `--max-old-space-size` makes it OOM _sooner_, not later).

**How to apply:** Don't expect to green a jest run (especially the
RUN_TESTCONTAINERS=1 real-Postgres DB tests under `utils/db/__tests__/*-db.test.ts`)
from the agent here. Validate DB-test changes structurally instead: `tsc --noEmit`
(clean), `eslint <file>`, `prettier --check <file>`, and mirror the assertion
patterns of the existing proven testcontainer cases in the same file. Mark the
jest run as environment-blocked rather than burning many attempts on it.

**tsc is also often unrunnable, and don't try to kill the dev server to free CPU.**
A cold `pnpm run typecheck:web` (`tsc --noEmit --incremental false`, TS6) can run
10+ min and exceed even multi-window polling, especially while the Next dev
workflow recompiles and competes for CPU. Two traps that waste turns:

- `kill`-ing the Next dev process (by PID _or_ `pkill -f`) cascades SIGTERM to the
  agent's own bash tool process (exit 143) **and reaps `setsid`-detached jobs**, so
  you cannot free CPU that way; the workflow supervisor also auto-restarts dev. Use
  `restart_workflow`, never manual kills.
- When tsc genuinely won't finish, fall back to: `eslint <changed files>` (uses the
  TS parser, catches most real errors) **plus** reading the exact signatures of
  every imported symbol you call and confirming arg/return types by hand. That
  targeted check covers the actual risk surface of small, pattern-following edits.
