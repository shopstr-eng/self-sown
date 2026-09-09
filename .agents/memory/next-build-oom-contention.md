---
name: Next build OOM contention
description: Cold Turbopack builds (Next 16.3.x) peak ~7GB against an ~8GiB VM — the only config lever that helped is turbopackFileSystemCacheForBuild:false; the rest is handled by the scripts/dev-server.sh supervisor.
---

Cold `next build` (Turbopack) peaks at ~7GB during "Creating an optimized production build", dominated by Rust-side native memory — the V8 heap cap is nearly irrelevant. The VM's `free` shows ~2GB used outside our cgroup (host noise we cannot free), so a cold build only fits when nothing else heavy runs, and even then by a hair.

**What works:** (1) `experimental.turbopackFileSystemCacheForBuild: false` — the 16.3.x default-on FS build cache buffers serialization in memory; disabling it turned coin-flip SIGKILLs into passing colds, and warm rebuilds were never faster here anyway, so it is disabled under the dev-only MM_DEV_BUILD gate in next.config.mjs. (2) Removing contention: kill tsserver/typescript-language-server (~1.5-2.5GB, they respawn lazily). Heap caps, RAYON_NUM_THREADS, workerThreads, minify/sourcemap/eviction toggles did NOT individually move the result. If cold builds start SIGKILLing again after a Next minor bump, check the config schema for newly-defaulted memory features before tuning heap.

**Why a supervisor:** even with the levers above, host memory noise still kills some cold builds, and the workflow's 300s port wait kills slow ones. The `dev` script is `bash scripts/dev-server.sh` (see its header for the current behavior contract: port-first status page, memory gate, IDE kill, OOM retries, last-good fallback, self-heal loop). A placeholder page at the preview = a build is in flight or self-healing — read the workflow log before concluding anything is broken, and don't hand-run cold `next build` alongside it.

**How to apply:** behavior changes to the supervisor must keep scripts/dev-server.test.sh green (stub-based, no real build). Trap it guards: bash `if cmd; then` without `else` resets `$?` to 0 (capture failures in an explicit `else`), and a background retry loop must re-classify each failure or a real compile error gets retried forever behind an "OOM retrying" status page.
