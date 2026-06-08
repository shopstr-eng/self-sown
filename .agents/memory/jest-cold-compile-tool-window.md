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
