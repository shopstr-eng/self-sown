---
name: Next build OOM contention
description: Cold Turbopack builds get OOM-killed (exit 137) when other heavy jobs (typecheck/tsc, tsserver) run concurrently — serialize heavy work, never restart the dev workflow in parallel with typecheck.
---

Cold `next build` (Turbopack) in this container is right at the memory edge (~8 GiB cgroup). When it runs concurrently with `tsc --noEmit` (typecheck workflow) or a fat tsserver, the kernel SIGKILLs the PostCSS/Turbopack subprocess — surfacing as either `exit code 137` with no other output, or a misleading "postcss loader crashed / globals.css" Turbopack error.

**Why:** A dev-workflow restart fired alongside a typecheck restart OOM'd repeatedly (4+ failures); the same build succeeded with the same 3072MB heap once nothing else was running. The heap cap (NODE_OPTIONS --max-old-space-size) does NOT protect against this — Turbopack's native workers allocate outside the V8 heap, so the fix is removing contention, not raising the cap.

**How to apply:** Before a cold build/workflow restart: kill tsserver, let any running typecheck/test workflow finish first, and check `free -m` (want ~5 GiB available). Run one heavy job at a time. If a build OOMs, check what else was running before concluding the code or version is at fault. Raising the heap beyond ~3072MB makes contention OOMs _more_ likely, not less.

## 16.3.x build FS cache is the OOM margin — disable it under MM_BUILD_LOW_MEM

Next 16.3.x defaults `experimental.turbopackFileSystemCacheForBuild: true`. Its in-memory cache serialization added just enough peak RSS that cold production builds in this container became a coin-flip SIGKILL at ~7.0–7.1GB (one pass at 7.13GB, multiple kills at 7.01–7.09GB — all at the "Creating an optimized production build" step, ~2min in). Setting `turbopackFileSystemCacheForBuild: false` in the MM_BUILD_LOW_MEM block made builds pass reliably (two consecutive colds at ~7.0GB). Warm rebuilds were never faster here anyway (every workflow restart rebuilds fully), so the cache had no upside in this environment.

**Why:** measured failures — `MALLOC_ARENA_MAX=2` did NOT help (still killed at 7.01GB); `--no-mangling` did NOT help (killed at 7.05GB). Only removing contention (tsserver) or disabling the FS build cache moved the result. V8 heap cap is nearly irrelevant: the main next-build process hits ~5.3GB RSS, dominated by Turbopack native memory.

**How to apply:** if cold builds start SIGKILLing again after a Next minor bump, check for newly-defaulted memory features in the config schema and try disabling them under MM_BUILD_LOW_MEM before tuning heap. Don't bump the heap past 2048 in the dev script — the native side, not V8, is what gets killed.
