---
name: Dev workflow serves a production build
description: The "Next.js Dev Server" workflow runs next build + standalone server, not next dev — no hot reload; live-verifying any source edit requires a workflow restart (~2.5min rebuild).
---

The `Next.js Dev Server` workflow command is `bash scripts/dev-server.sh` — a supervisor that runs a PRODUCTION build (not `next dev`, no hot reload) and then serves `.next/standalone/server.js`. During build failures it intentionally serves a placeholder status page or the last-good bundle instead.

**Why:** A served page can contradict the source on disk (e.g. a meta tag that was just edited still renders the old value), which looks exactly like a logic bug or a mystery duplicate emitter. It cost a debugging cycle here. The last-good fallback means the preview can intentionally serve STALE code after build failures — check the workflow log for "serving the LAST GOOD build" before trusting the preview.

**How to apply:** Before curl-verifying any source change live, restart the workflow and wait for the full rebuild. If served HTML doesn't match source, suspect a stale build FIRST, not the code. A long-lived "Building the app…" placeholder means builds are being OOM-killed — see next-build-oom-contention.md. Unit jest + LSP remain the fast verification loops; reserve restarts for end-to-end checks.
