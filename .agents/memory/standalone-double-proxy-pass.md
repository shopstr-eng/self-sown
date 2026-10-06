---
name: Standalone double proxy pass strips x-ss-* headers
description: Next standalone re-runs proxy.ts on middleware rewrite targets; the second pass sees the internal host and stripInternalHeaders drops x-ss-* before the handler runs
---
The Next.js standalone runtime (what `next build` + `node .next/standalone/server.js` runs, i.e. dev workflow AND production deploys here) executes proxy.ts TWICE for a rewritten request: once for the public path (real Host header), then again for the rewrite target URL — where `request.url`'s host is the internal listen address (e.g. localhost:PORT), so routing falls into the PLATFORM branch and `stripInternalHeaders` deletes every inbound `x-ss-*` header as a forgery. Query params and `x-stall-*`-style headers survive both passes.

**Why:** `stripInternalHeaders` is deliberate anti-forgery — do not weaken it. Verified live via instrumented resolve-routes.js: pass 1 emitted the correct `x-ss-custom-domain-host`, pass 2 stripped it, handler rendered custom-domain content with platform URLs.

**How to apply:** any state a proxy rewrite must deliver to an API handler across this double pass must ALSO travel in the rewrite URL's query string (handler prefers the header, falls back to the query param — see buildStallAgentViewRewrite / stall-agent-view `host` param). When debugging header loss on rewritten routes, suspect the second pass before blaming the handler.
