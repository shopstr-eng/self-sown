---
name: checksVoidReturn lint conventions
description: no-misused-promises checksVoidReturn is on for server code — how to fix the two flagged patterns without disabling the rule
---

`@typescript-eslint/no-misused-promises` runs with `checksVoidReturn: true` in the server-side eslint block (pages/api, mcp/, utils/, scripts/ in eslint.config.mjs). Two fix patterns, both already established in the repo:

1. Fire-and-forget async callbacks (setTimeout/setInterval/listeners): wrap the call in `void`, e.g. `setInterval(() => void processEmails(), X)`. See utils/email/flow-scheduler.ts.
2. Async Promise executors `new Promise(async (resolve, reject) => ...)`: convert to `promiseFromAsync(async (resolve, reject) => ...)` from utils/promise-from-async.ts. This is a one-line callee swap (no reindent) and routes post-await escapes to reject() instead of unhandled rejections. Used throughout utils/nostr/fetch-service.ts.

**Why:** `pnpm run lint:web` must stay at 0 errors; both patterns are flagged as errors, and async executors genuinely swallow post-await rejections.
**How to apply:** when lint flags "Promise returned in function argument where a void return was expected", pick pattern 1 for intentional fire-and-forget, pattern 2 for promise executors; never add per-line eslint-disable for these.
