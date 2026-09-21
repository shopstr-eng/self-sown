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
When auditing, grep `return handle[A-Z]` without `await` in pages/api. Note
that lint rules like `no-return-await` push the wrong way here — the await
is semantically required inside try/catch.

Await alone is not enough if the route's PREAMBLE (rate limit, table init,
auth) still runs before the try opens: those steps hit the DB directly, so
the entire handler body must sit inside the one try/catch. When testing a
route that memoizes table init behind a module-level `ready` flag, an
init-rejection case only works on a fresh module — `jest.resetModules()` +
dynamic re-import, or a prior passing test's flag skips the init call and
the rejection mock is never consumed.
