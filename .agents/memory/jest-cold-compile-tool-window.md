---
name: Jest haste-map must exclude the .next build dir
description: next/jest only ignores .next for test/watch, NOT the haste-map crawl; the dev workflow's next build makes jest crawl/parse .next/standalone and crash + run slow.
---

# jest must not crawl `.next`

The dev workflow runs `next build` (standalone output), so `.next/standalone`
exists and contains a FULL copied `node_modules` tree plus many `package.json`
files. Jest's haste map crawls the whole rootDir, so it walks `.next/standalone`
too. Two failures result:

1. **Crash:** `Error: Cannot parse .next/standalone/package.json as JSON: ENOENT`
   — the running dev `next build` rewrites those files mid-crawl, so a worker
   reads a file that just vanished.
2. **Slowness:** crawling the duplicated `node_modules` under `.next/standalone`
   roughly doubles haste-map work and RAM, which is what made cold jest runs
   appear to never finish in a 120s bash window.

**Fix (in `jest.config.cjs`):** add `modulePathIgnorePatterns: ["<rootDir>/.next/"]`.
`next/jest` only adds `/.next/` to `testPathIgnorePatterns` + `watchPathIgnorePatterns`;
the haste-map ignore is built from `modulePathIgnorePatterns` (confirmed in
jest-runtime: `ignorePatternParts = [...config.modulePathIgnorePatterns, ...]`),
so `.next` must be listed there explicitly or the crawl still happens.

**Why it matters:** with `.next` excluded, the `test-ucp-geo` workflow AND a plain
`npx jest __tests__/utils/ucp __tests__/utils/geo` bash call both pass in ~24s
wall (7 suites / 77 tests). So mocked/unit jest IS runnable from the agent here —
the earlier "cold start never finishes in 120s" belief was the `.next` crawl, not
an inherent next/jest limit.

## Still genuinely unrunnable / slow

- **RUN_TESTCONTAINERS=1 real-Postgres DB tests** (`utils/db/__tests__/*-db.test.ts`):
  need a live Postgres container; validate structurally (`tsc --noEmit`, `eslint`,
  `prettier --check`) and mirror existing proven testcontainer cases instead.
- **A full cold `tsc --noEmit` typecheck** can still run 10+ min, especially while
  the Next dev workflow competes for CPU. Don't kill the dev server to free CPU:
  `kill`/`pkill -f` the Next dev process cascades SIGTERM to the agent's own bash
  tool (exit 143) and reaps `setsid`-detached jobs; the supervisor auto-restarts
  dev anyway. Use `restart_workflow`, and fall back to `eslint` + reading exact
  signatures of imported symbols for small pattern-following edits.
