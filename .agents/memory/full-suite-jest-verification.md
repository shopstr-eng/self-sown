---
name: Full Jest suite verification here
description: How to run/verify the whole ~222-suite Jest suite reliably in this repo without false-flaky failures or OOM
---

Verify the full suite with three serial runInBand shards, NOT one big parallel run:
`npx jest --runInBand --shard=1/3`, then `2/3`, then `3/3` (one at a time).

**Why:** the Next.js dev server is always running here, and heavy parallel Jest
(`--maxWorkers=3/4`) competes with it for CPU/memory on this small box. That
starvation does two bad things:

- OOM-kills the run with **no output at all** (looks like a crash, isn't a test failure).
- Starves individual async assertions so otherwise-green suites throw _false_ failures:
  Testing Library `findByRole`/`getByRole` (default 1000ms) and per-test (5000ms)
  timeouts get exceeded. Seen concretely on `shop-profile-form` (async "Save Stall"
  button) and `migration-prompt-modal` (`role="alert"`). Both pass 100% in isolation.

**How to apply:**

- If a suite fails ONLY in the full parallel run but passes when run isolated, it's
  contention — not a stale/broken test. Don't rewrite the component or the assertion.
- For elements that render after a data-load path, prefer `findByRole` over `getByRole`;
  bump `findByRole(role, {}, { timeout: 5000 })` for async assertions that must survive a loaded process.
- A runInBand shard may exit **124** from the `timeout` wrapper because Jest hangs on
  open handles AFTER printing "Ran all test suites" — the results are still valid. Add
  `--forceExit` or just read the `Tests:`/`Test Suites:` summary lines.
- Known-skipped and NOT agent-runnable (leave skipped): `db-service.test.ts`
  (`RUN_TESTCONTAINERS`), `export-bundle-full-build.test.ts` (`RUN_SELF_HOST_BUILD`).
