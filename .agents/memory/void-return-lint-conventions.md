---
name: checksVoidReturn lint conventions
description: no-misused-promises checksVoidReturn is on for server AND client code — how to fix the flagged patterns without disabling the rule
---

`@typescript-eslint/no-misused-promises` runs with `checksVoidReturn: true` repo-wide in eslint.config.mjs: a strict server block (pages/api, mcp/, utils/, scripts/ — also no-floating-promises + checksConditionals) and a client block (components/, non-api pages/ — checksVoidReturn only; floating promises and conditionals deliberately not flagged in components). Fix patterns, all established in the repo:

1. Fire-and-forget async callbacks (setTimeout/setInterval/listeners): wrap the call in `void`, e.g. `setInterval(() => void processEmails(), X)`. See utils/email/flow-scheduler.ts.
2. Async Promise executors `new Promise(async (resolve, reject) => ...)`: convert to `promiseFromAsync(async (resolve, reject) => ...)` from utils/promise-from-async.ts. This is a one-line callee swap (no reindent) and routes post-await escapes to reject() instead of unhandled rejections. Used throughout utils/nostr/fetch-service.ts.
3. JSX event handlers: named async handler reference `onPress={handleSave}` becomes `onPress={() => void handleSave()}`; an inline async arrow with a multi-statement body gets extracted to a named `handleX` in the component body and void-wrapped at the attribute. react-hook-form: `onSubmit={(e) => void handleSubmit(onSubmit)(e)}`. The `void` goes at the call/callback site, never on the async declaration.

**Why:** `pnpm run lint:web` must stay at 0 errors; an un-awaited async event handler swallows rejections — the user clicks, nothing happens, nothing is logged.
**How to apply:** when lint flags "Promise-returning function provided to attribute/property where a void return was expected", pick pattern 3 for JSX handlers, 1 for timers/listeners, 2 for promise executors; never add per-line eslint-disable for these. Caveat: many legacy handlers were void-wrapped WITHOUT adding error handling — a wrapper means "intentionally fire-and-forget", not "errors surface to the user".
