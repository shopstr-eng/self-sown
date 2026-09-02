---
name: Real-Postgres tests in the Replit sandbox
description: Testcontainers can't bind ports in the sandbox; gate real-DB tests behind an external-URL env var and run them against the dev DATABASE_URL with synthetic-marker cleanup.
---

Docker exists in the sandbox (`docker info` succeeds, images pull), but testcontainers still fails: container host ports never bind ("Port 5432/tcp not bound after 120000ms" / health-check timeouts). Do not burn time retrying RUN_TESTCONTAINERS=1 here.

Working pattern for real-Postgres tests (proven with utils/db/__tests__/cashu-escrow-service-db.test.ts):

- Dual-gate the suite: `RUN_TESTCONTAINERS=1` for CI Docker, else a `*_TEST_DATABASE_URL` env var pointing at an existing Postgres, else skip. The skip path keeps the default suite fast.
- Run it here with `ESCROW_CONCURRENCY_TEST_DATABASE_URL="$DATABASE_URL" npx jest <file> --runInBand` — the dev Replit Postgres is a real database and exercises true row-lock/isolation behavior.
- Namespace test rows behind a synthetic marker (e.g. an all-"a" buyer pubkey) and DELETE them in afterEach/afterAll (exact ids + LIKE sweep for interrupted runs).
- True concurrency needs no threads: `Promise.all` of pool queries on a max-10 pool puts multiple statements in flight server-side.
- A finalize racing an opposite-action enqueue locks the outbox and registration rows in opposite order — Postgres deadlock detection aborts one. That's fail-closed/retryable, NOT a correctness bug; assert invariants (one row, single resolution) rather than which side wins.
- Test files with only `await import()` and no top-level import/export are global scripts — type aliases collide across test files under project-wide tsc; add `export {};`.

**Why:** memory previously said "real-Postgres testcontainer tests aren't agent-runnable" — the precise blocker is port binding, and the dev-DATABASE_URL mode makes them agent-runnable after all.
**How to apply:** any new real-DB concurrency/isolation test should copy the dual-gate harness and be verified against the dev DB before handoff.
