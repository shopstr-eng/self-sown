---
name: Headless browser verification
description: How to inspect the live DOM / computed styles / loaded fonts of the running app — no puppeteer/playwright installed, but a chromium binary exists
---

No puppeteer or playwright in node_modules, but a chromium binary is at `/repl/tools/bin/chromium`.

**Why:** Needed to verify client-injected styles/fonts that never appear in SSR HTML (storefront fonts are applied client-side after the Pro gate resolves).

**How to apply:**
- Static post-hydration DOM: `chromium --headless --no-sandbox --disable-gpu --virtual-time-budget=15000 --dump-dom <url>`
- Computed styles / `document.fonts` / runtime JS: launch with `--remote-debugging-port=<port>`, then drive CDP over the WebSocket from a plain Node script (Node 22 has global `WebSocket` and `fetch`; `PUT /json/new?<url>` opens a tab, `Runtime.evaluate` with `awaitPromise: true, returnByValue: true` runs async probes). Never `pkill` the browser — it kills the agent shell; kill by PID.
