---
name: Dev workflow serves a production build
description: The "Next.js Dev Server" workflow runs next build + standalone server, not next dev — no hot reload; live-verifying any source edit requires a workflow restart (~2.5min rebuild).
---

The `Next.js Dev Server` workflow command is `next build && cp static/public into .next/standalone && node .next/standalone/server.js` — a PRODUCTION build, not `next dev`. There is no hot reload.

**Why:** A served page can contradict the source on disk (e.g. a meta tag that was just edited still renders the old value), which looks exactly like a logic bug or a mystery duplicate emitter. It cost a debugging cycle here.

**How to apply:** Before curl-verifying any source change live, restart the workflow and wait for the full rebuild (~2.5min compile). If served HTML doesn't match source, suspect a stale build FIRST, not the code. Unit jest + LSP remain the fast verification loops; reserve restarts for end-to-end checks.
