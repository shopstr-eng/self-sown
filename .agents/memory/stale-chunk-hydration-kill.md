---
name: Stale-chunk hydration kill (invisible images after rebuild)
description: Why images "don't load" after dev rebuilds despite 200s — old chunks 404, hydration dies, HeroUI images stuck at opacity-0; dev-server.sh carries static assets forward across swaps
---

Symptom: after merge/rebuild churn, user reports logo, avatars, and product images "don't load at all" in a long-lived tab, while fresh browsers render fine and every asset returns 200.

Mechanism: `scripts/dev-server.sh` swaps in a new standalone bundle per rebuild; content-hashed chunks from the prior build disappear. Tabs holding pre-rebuild HTML 404 their JS → hydration never runs → HeroUI `Image`/`Avatar` stay at `opacity-0` (they only flip to visible via `data-[loaded=true]` after hydration). Server is healthy; the tab is broken.

**Why:** The standalone swap is atomic per-build and nothing preserved the old build's chunks. Diagnosis dead-ends: SSR HTML contains the `<img>`, curl gets 200s, CSS rules exist — the failure is client-side hydration, invisible from the server.

**How to apply:** `assemble_and_save()` unions `$LAST_GOOD/.next/static` into the new standalone (`cp -rn`, no-clobber; colliding content-hash names mean identical content), aborts promotion if the copy fails, caps the carried tree at 250MB, and promotes via staged `.new` → two checked renames with rollback (never `rm -rf` the live dir — the old server keeps serving from it until `serve_foreground` stops it). `.prev` survives until the next assemble; `serve_something_now` restores from it if a kill landed mid-swap. Any change to the swap logic must preserve these properties. Regression coverage: `scripts/dev-server.test.sh` case F. Accepted residual: a sub-ms pathname gap between the two renames, and >250MB churn drops history for one generation (stale tabs then just need a refresh).

Diagnostic recipe for "images missing but network is green": pixel-stat the nav region of a screenshot via sharp (`extract` + `stats`, stddev >~50 = content rendered). Stddev 0 = truly blank. Remember the nav container is centered — on a 1920px viewport the logo starts near x≈336, not x=0.

Companion mechanism: `UpdateToast` (components/utility-components/update-toast.tsx) polls `/api/version` and prompts a hard refresh on build mismatch — the carry-forward keeps old tabs working, the toast gets users off them. `/api/version` must read BUILD_ID relative to the SERVED bundle (standalone chdirs to its own dir, so cwd/.next/BUILD_ID is correct; a last-good server keeps reporting its own old build, which is what its tabs need) and must stay in the custom-domain API allowlist in proxy.ts or the toast silently never fires on seller domains.
