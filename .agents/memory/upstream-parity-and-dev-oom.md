---
name: Upstream-parity merge-record + dev cold-compile OOM
description: Two gotchas from the big upstream (shopstr) hand-port — how to record git parity, and why the dev server dies after a dep install
---

# Recording git "up-to-date with upstream"

The fork (milk-market) is heavily diverged from `upstream/main`; we hand-port upstream areas rather than `git merge` (a raw merge clobbers diverged downstream files). To make `git` show parity afterward, the intended marker is `git merge -s ours upstream/main` (keeps our tree, records upstream as a merged parent so "behind" drops to 0).

**Constraint:** the main agent cannot run this — `git merge`/`git commit` are blocked destructive ops, and the auto-checkpoint/Project-Task merge-back is _content-based_, so a history-only (zero file diff) merge-record may not survive it. Practical paths: delegate to a background Project Task, or have the user run the one-liner themselves. Do NOT attempt a raw `git merge upstream/main`.

**How to apply:** when asked to "merge all upstream" or "show up-to-date with upstream," port area-by-area (diff `<merge-base>..upstream/main` for the files, check downstream divergence, port only genuine net improvements, preserve downstream features, adapt UI to neo-brutalist, typecheck). The literal git parity record is a separate, last step that the main agent must hand off.

# Dev server dies right after a dependency install

`pnpm install` wipes the `.next` Turbopack cache. The dev workflow runs with `NODE_OPTIONS='--max-old-space-size=1024'` (1GB). The first _cold_ compile of the heaviest SSR route (the homepage `/` — `getServerSideProps` pulls Postgres + Nostr for OG meta) can exceed 1GB and the process exits → workflow flips to NOT_STARTED. The server itself boots fine ("✓ Ready in <1s").

**Why:** this is an environmental memory ceiling, NOT a code regression — `tsc --noEmit` (use `NODE_OPTIONS='--max-old-space-size=3072'`; plain tsc OOMs) stays clean through it.

**How to apply:** don't chase it as a code bug after a dep bump. The bash tool also kills any backgrounded `next dev` at call timeout, so you can't warm the cache outside the workflow — and leaked `next dev` processes from such attempts eat RAM and make everything else OOM (kill them with `pkill -9 -f "next dev"`). Verify health via typecheck + clean boot; treat heavy cold compiles as slow/environmental.

## The OOM can disguise itself as a Turbopack `parse_css` crash on globals.css

A cold `next build` can fail with `TurbopackInternalError: [project]/styles/globals.css [client] (css)` → `parse_css` / `PostCssTransformedAsset::process` / `evaluate_webpack_loader` → "failed to receive message / reading packet length / unexpected end of file". This is **not** a CSS/Tailwind/PostCSS regression — it's the native PostCSS worker subprocess being OOM-killed mid-IPC. It reproduces deterministically on the same module (globals.css) when RAM is tight, which makes it look like a code bug. Confirm scope with `git status` (if nothing under `styles/`, tailwind/postcss config, or `next.config` changed, it's not your edit).

**Why:** under the 7.7GB container ceiling the biggest competitor for RAM is the IDE's own LSP — two `tsserver.js` processes can hold ~2.5GB combined. Add the 2GB build + system and the PostCSS worker gets squeezed and killed.

**How to apply:** before restarting the workflow for a cold rebuild, free LSP RAM with `pkill -9 -f "tsserver.js"` (and `pkill -9 -f "typescript-language-server"`) — they respawn on demand. With ~4–5GB free the same 2GB build compiles fine (~85s). Also: NEVER `kill -9` a manual `next build` mid-flight — it corrupts `.next` (truncated cache → the same "unexpected end of file") AND leaks build workers that keep eating RAM; if you started one in the background, let it finish or `rm -rf .next` afterward.

# Memory-free preview = build + run the standalone server (not next dev, not next start)

To preview without the dev OOM, the `dev` script does a memory-bumped production build then serves it: `next build && cp -r .next/static .next/standalone/.next/static && cp -r public .next/standalone/public && PORT=5000 HOSTNAME=0.0.0.0 node .next/standalone/server.js`. The old hot-reload dev is preserved as `dev:hot`.

**Why:** `next.config` sets `output: "standalone"`. `next start` with standalone prints a warning and doesn't serve the bundle's static/public assets (you get asset 404s). The standalone server (`node .next/standalone/server.js`) reads `PORT`/`HOSTNAME` env (not `-p`/`-H` flags) and needs `.next/static` + `public` folded in first — same steps as `scripts/deploy-build.sh`. A prod build runs comfortably at `--max-old-space-size=2048`.

**How to apply:** trade hot-reload for stability — after code changes, restart the workflow to rebuild (~50–65s). Unrelated pre-existing 404s remain in this preview: `/sw.js`, `/workbox*` (PWA service worker, not emitted by this config) and `/favicon.ico`; they don't affect rendering, don't chase them as part of preview work.

# Prod-build Turbopack panic = OOM under IDE memory contention

`restart_workflow` can hard-FAIL (TASK_FAILED, not timeout) with a Turbopack panic on `[project]/styles/globals.css ... evaluate_webpack_loader ... failed to receive message / reading packet length / unexpected end of file`. That string is a Turbopack worker subprocess getting OOM-killed mid-CSS-parse — NOT a CSS/PostCSS/Tailwind code error, and NOT caused by unrelated JSX/asset edits.

**Why:** the 2GB-heap prod build competes for RAM with the IDE's TypeScript language servers (`node .../typescript/lib/tsserver.js`), which can hold ~2GB+ combined. With only ~2.5GB free the native worker dies; it fails deterministically while memory stays starved (looks like a code bug but isn't).

**How to apply:** check `free -h`. If available RAM is low and tsserver is large, `pkill -f "typescript/lib/tsserver.js"` (IDE respawns them lazily, no code/data impact) frees ~2GB, then restart the workflow — it builds cleanly.
