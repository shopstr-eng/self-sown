---
name: Test files must not live under pages/
description: Why a Jest test colocated in pages/ either crashes `next build` OR silently ships as a public route
---

Jest/RTL test files must NOT live anywhere under `pages/` (e.g.
`pages/api/shipping/__tests__/foo.test.ts`). Keep them in the top-level
`__tests__/` tree instead.

**Why:** Next.js treats every file under `pages/` (matching pageExtensions,
which includes `.test.ts(x)` since it ends in `ts`/`tsx`) as a route. `next
dev` (Turbopack) tolerates it; a production `next build` has TWO failure
modes depending on what the test module does at evaluation:

1. If the file references jest globals at module top level, "Collecting page
   data" module-evaluates it and throws `ReferenceError: expect is not
defined` — the whole build fails.
2. If the globals are only touched inside `describe`/`it` callbacks (the
   common case for handler tests using `jest.mock`), it compiles fine and
   **silently ships as a live public API route** (e.g.
   `/api/shipping/__tests__/foo.test`) — an exposure, not a crash. The build
   log's route list is where you catch it.
   Either way it's a latent trap that never shows in dev. This repo has no
   `pageExtensions` filter, so nothing catches it automatically.

**How to apply:** When adding or relocating component/page tests, put them
under top-level `__tests__/` (mirroring the source path, e.g.
`__tests__/pages/listing/listing-page.test.tsx`). Jest still finds them
(next/jest default testMatch scans `**/__tests__/**` and `*.test.*`
anywhere) and `@/...` import aliases resolve from any location. After any
merge, `find pages -name '*.test.*'` should return nothing.
