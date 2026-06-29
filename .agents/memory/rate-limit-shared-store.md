---
name: Rate limiter shared store + fail-open
description: The agent/API rate limiter is Postgres-backed (cross-instance) with an in-memory fallback; testing + 429-body invariants that are easy to get wrong.
---

# Rate limiter: shared Postgres store with in-memory fallback

`utils/rate-limit.ts` counts in a shared Postgres table (`rate_limit_counters`,
keyed by `(bucket, rate_key)`) via `incrementRateLimitCounter` in
`utils/db/db-service.ts`, so the configured ceiling holds across horizontally
scaled instances instead of per-process. `checkRateLimit`/`applyRateLimit` are
**async** (return Promises) — every caller in `pages/` must `await` them and the
enclosing handler must be `async`.

**Why fail-open matters:** the limiter is advisory. On ANY store error (DB down,
`DATABASE_URL` unset in unit tests, mock that omits the export) `checkRateLimit`
catches and falls back to the per-process in-memory counter
(`checkRateLimitInMemory`). It must NEVER throw a request into a 5xx just because
the store is unreachable. Degraded mode is effectively `N × limit` (one budget
per instance) — acceptable; blocking is not.

**How to test limit-walking deterministically:** a test that fires N requests to
prove the (N+1)th is a 429 (e.g. `agent-view.test.ts`) MUST
`jest.mock("@/utils/db/db-service", ...)` so `incrementRateLimitCounter` throws,
forcing the in-memory path. The in-memory path is the only one
`__resetRateLimitBuckets()` can reset between tests. The dev Postgres IS
reachable from jest, so without the mock the real shared counter is used and
`__resetRateLimitBuckets` becomes a no-op → cross-test interference.

**429 body is a fixed contract.** `applyRateLimit` emits
`{ error: "Too many requests", code: "rate_limited", retryAfterSeconds: N }`
(plus `Retry-After` + IETF/`X-RateLimit-*` headers). This is the canonical shape
(see `agent-view.test.ts`). One older test —
`__tests__/pages/api/db/delete-events.test.ts` — asserts the bare legacy body
`{ error: "Too many requests" }` and is a **pre-existing stale failure**, NOT a
regression of the store swap (the structured body predates it). Don't "fix" it by
weakening `applyRateLimit`; update that assertion if you touch it.

**The async migration exposed latent pre-existing broken API-route tests.** The
limiter always writes `X-RateLimit-*` headers on the success path, so any
node-mock-response helper that omits `setHeader` now throws `res.setHeader is not
a function` and masks every assertion after it. Several seller-action endpoint
tests (`register-slug`, `create-account-link`, `nostr-json`) were already broken
on `origin/main` for this reason and only _surfaced_ during the rate-limit review
— they are NOT regressions of the swap. After adding `setHeader` to the mock, a
second latent bug can appear: a seller-action test must sign its NIP-98 event with
the handler's EXACT `verifyNostrAuth` binding (`{ method, path, fields }`, using
the RAW pre-sanitization field values), or auth 401s before any DB query runs and
a `toHaveBeenCalledTimes` count assertion fails for the wrong reason.

**Unrelated pre-existing tsc noise:** repo ships with `noUncheckedIndexedAccess`
errors on `PAGE_CONTENT[path]` / `PAGE_FINGERPRINT[path]` style index access in
several `__tests__/utils/geo/*` and the agent-view test, plus unused-var warnings
in `marketplace.tsx` / `fetch-service.ts`. jest transpiles (swc) and ignores
these, so they don't block tests; don't mistake them for your own breakage.
