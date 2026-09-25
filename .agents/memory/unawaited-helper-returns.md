---
name: Un-awaited helper returns escape try/catch
description: `return asyncHelper(...)` without await inside a handler's try block lets rejections bypass the catch — the route's error mapping, status codes, and cleanup never run.
---

In Next.js API routes (and any async handler) that delegate to an async
helper, `try { ... return helper(...) } catch { ... }` does NOT catch
rejections from `helper` — the promise escapes the try scope. The caller
gets an unhandled rejection instead of the route's intended error response,
and any catch-side cleanup or error-code mapping is skipped.

**Why:** this shape sat latent in a payments route: every async failure mode
inside the helper (DB outage, provider error, FX failure) produced an
unhandled rejection rather than the route's clean 500, and it only surfaced
when a new fail-closed write was added inside the helper and tested.

**How to apply:** when a helper gains a throwing call, check the call site:
`return helper(...)` inside try/catch must become `return await helper(...)`.
Server-side code is guarded by the type-aware `@typescript-eslint/return-await`
("in-try-catch") rule — see eslint.config.mjs for the current scope; client
components are intentionally excluded. Note that lint rules like
`no-return-await` push the wrong way here — the await is semantically required
inside try/catch. The rule also flags redundant `return await` OUTSIDE
try/catch; removing those is behavior-neutral.

**Pre-commit trap (verified):** OUTSIDE try/catch the two guards fight. The
pre-commit hook's eslint --fix strips `return await helper(...)` down to the
bare `return helper(...)`, and the jest source scan in
__tests__/pages/api/unawaited-helper-returns.test.ts then fails the commit on
that same line. The commit loops until you pick the shape both accept: an
awaited STATEMENT plus a bare `return;` —
`await handleX(...); return;` — never `return await handleX(...)` unless the
call sits inside try/catch.

When the flagged call sits inside a try/finally that holds a POOLED DB client,
do NOT fix it by awaiting a helper that checks out its own client from the
same pool — holding one client while waiting for a second deadlocks the pool
(max 10) under concurrency. Run the follow-up query on the already-held
client instead (and re-check the query's ownership scoping — the helper's
may differ from the caller's).

Await alone is not enough if the route's PREAMBLE (rate limit, table init,
auth) still runs before the try opens: those steps hit the DB directly, so
the entire handler body must sit inside the one try/catch. When testing a
route that memoizes table init behind a module-level `ready` flag, an
init-rejection case only works on a fresh module — `jest.resetModules()` +
dynamic re-import, or a prior passing test's flag skips the init call and
the rejection mock is never consumed.
