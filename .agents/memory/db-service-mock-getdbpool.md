---
name: db-service mocks must include getDbPool
description: utils/db/* modules call getDbPool() at module scope, so any jest.mock of @/utils/db/db-service without getDbPool kills the suite at import time
---

Several `utils/db/*.ts` modules (e.g. custom-domains.ts) call `getDbPool()` at
module scope. When a route under test transitively imports one of them, a
`jest.mock("@/utils/db/db-service", ...)` that omits `getDbPool` makes the
whole suite die at import with "TypeError: getDbPool is not a function" —
before any test runs, and it blocks the pre-commit hook
(scripts/run-staged-checks.mjs runs jest --findRelatedTests on staged files).

**Why:** the broken suite never shows a failing assertion; it fails to load,
so the regression looks unrelated to the file actually being committed.

**How to apply:** in route-level API tests that mock db-service, always add
`getDbPool: jest.fn(() => ({ query: jest.fn() }))` (a pool-shaped stub is
enough when the handler path never queries it), or mock the intermediate
module boundary (e.g. @/utils/stripe/apple-pay) instead.
