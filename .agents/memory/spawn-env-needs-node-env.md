---
name: Custom child-process env objects need NODE_ENV
description: In the web tsconfig, passing a hand-built env object to spawnSync/execFileSync fails tsc because Next's global.d.ts makes ProcessEnv.NODE_ENV required.
---

Passing a minimal hand-built env object (e.g. `{ PATH, HOME }`) to
`spawnSync`/`execFileSync` `env:` in a test fails the root typecheck with
TS2769: Next 16's `types/global.d.ts` declares `NODE_ENV` as **required** on
`ProcessEnv`.

**Why:** a validation cycle burned on this in a test that spawned plain Node to
evaluate the mobile app config; jest itself passed — only tsc complained.

**How to apply:** any custom env object for child_process in TS files must
include `NODE_ENV` (e.g. `"test"`), or spread `process.env` and delete keys.
