---
name: Self-host full-build test in the sandbox
description: The RUN_SELF_HOST_BUILD gated suite CAN run in this sandbox despite its header comment claiming CI-only; how to run it successfully.
---

The `pnpm run test:self-host-build` suite (utils/self-host/__tests__/export-bundle-full-build.test.ts) runs green in the agent sandbox even though its header comment says a cold compile OOMs here and it is CI-only. It takes ~7 min.

**Why:** Verified 2026-09-11 — with the Next.js Dev Server workflow stopped, a full pnpm install (warm store) + `pnpm build` + boot completes within RAM. The OOM claim in the file header predates the Tailwind source-glob fix.

**How to apply:**
- Stop the "Next.js Dev Server" workflow first (frees the ~2GB the production build holds); restart it after.
- Pass a scratch `DATABASE_URL` (create a throwaway DB on the local cluster); the booted instance runs initializeTables + background jobs against whatever it inherits.
- Build the scratch URL carefully: the env's DATABASE_URL has no explicit port, so naive URL rewrites can yield `host:None` → server-side "Invalid URL" noise from every background job.
- The suite needs the node jest env (jsdom has no `fetch`) and a seeded `shop_slugs` row for the synthetic tenant (fresh DB → stall SSR slug lookup finds nothing → `/` 404s). Both are baked into the test now.
- The `ELIFECYCLE exit code 143` line at the end is just afterAll SIGTERMing the spawned server; the jest result line above it is the verdict.
