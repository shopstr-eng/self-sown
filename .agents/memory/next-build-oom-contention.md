---
name: Next build OOM contention
description: Cold Turbopack builds get OOM-killed (exit 137) when other heavy jobs (typecheck/tsc, tsserver) run concurrently — serialize heavy work, never restart the dev workflow in parallel with typecheck.
---

Cold `next build` (Turbopack) in this container is right at the memory edge (~8 GiB cgroup). When it runs concurrently with `tsc --noEmit` (typecheck workflow) or a fat tsserver, the kernel SIGKILLs the PostCSS/Turbopack subprocess — surfacing as either `exit code 137` with no other output, or a misleading "postcss loader crashed / globals.css" Turbopack error.

**Why:** A dev-workflow restart fired alongside a typecheck restart OOM'd repeatedly (4+ failures); the same build succeeded with the same 3072MB heap once nothing else was running. The heap cap (NODE_OPTIONS --max-old-space-size) does NOT protect against this — Turbopack's native workers allocate outside the V8 heap, so the fix is removing contention, not raising the cap.

**How to apply:** Before a cold build/workflow restart: kill tsserver, let any running typecheck/test workflow finish first, and check `free -m` (want ~5 GiB available). Run one heavy job at a time. If a build OOMs, check what else was running before concluding the code or version is at fault. Raising the heap beyond ~3072MB makes contention OOMs *more* likely, not less.
