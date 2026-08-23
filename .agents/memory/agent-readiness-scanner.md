---
name: Agent-readiness scanner gaps (JSON 404, rate-limit headers, WBA key discovery)
description: How to satisfy an external agent-readiness scanner's "Structured errors (JSON 404)", "Rate limit headers", and "Public keys discoverable" checks in this Next.js pages-router app.
---

External agent-readiness scanners (e.g. metaend-grade) probe the **live deployed site root and random paths**, not just `/api`. Three recurring gaps and their durable fixes:

## 1. Structured errors (JSON/markdown 404) — the only _required_ (non-optional) check

All agent-facing 404s route through `tryWriteAgentNotFound` / `acceptsMarkdown` / `buildAgentNotFoundMarkdown` in `utils/api/agent-error.ts`. **Any new agent-facing 404 surface must reuse those helpers** — do not hand-roll negotiation.

- **Surfaces wired:** root catch-all `pages/[...notFound].tsx`, API catch-all `pages/api/[...notFound].ts`, all stall GSSP `notFound` sites (via a `stallNotFound()` closure that names the public path from `x-mm-original-path` on custom domains), and both 404s in `pages/api/stall-agent-view.ts` (proxy routes non-HTML stall requests there, bypassing the page GSSP — so both layers need wiring).
- **Negotiation is q-aware (RFC 9110):** markdown wins ties, HTML only when strictly preferred, `*/*` gets JSON. A naive `accept.includes("text/html")` check fails `Accept: text/markdown, text/html;q=0.1`.
- The `res.end()` then `return { props: {} }` pattern in GSSP is safe on Next 16 (finished response suppresses render).
- After `res.end()`, return `{ props: {} as Props }` to satisfy typed GSSP.

**Why:** scanner required check + agents need machine-readable errors on every host, incl. custom domains.

## 2. Rate limit headers (optional)

Only the agent API endpoints set them; the homepage/general responses didn't.
**Fix:** wrap the proxy — rename the body to `routeRequest`, export a `proxy` that calls `withAdvisoryRateLimitHeaders(await routeRequest(req))`. It adds advisory `RateLimit-*`/`X-RateLimit-*`/`RateLimit-Policy` to every response (covers both hosts).
**Duplicate guardrail:** endpoints that already set accurate per-request headers via `applyRateLimit` (WBA directory + agent-view + stall-agent-view rewrites) tag their middleware response with an `x-mm-rl-skip` marker; the wrapper skips them and strips the marker. **Watch indentation:** the platform `/stall/<slug>` agent branch is more deeply nested, so a bulk replace keyed on 6-space indent misses it — verify every rewrite branch carries the marker.

## 3. Public keys discoverable (optional)

The WBA directory at `/.well-known/http-message-signatures-directory` is _found_ (status 200) but keys report as not discoverable.
**Root cause:** naive scanners gate JSON parsing on the literal substring `application/json`; the spec media type `application/http-message-signatures-directory+json` does NOT contain that substring, so they never parse the JWK Set.
**Fix:** content-negotiate the directory `Content-Type` — serve `application/json` when `Accept` includes `application/json` (and not the registered type), else the registered media type for spec-aware verifiers (Cloudflare). `Vary: Accept` already set.

## 4. MCP keyless sessions + error-envelope contract

The MCP endpoint (`pages/api/mcp/index.ts`) allows unauthenticated `initialize` (advertised by `/.well-known/mcp.json`): null-key sessions get read tools only, keyed checks compare `?.id ?? null` on both sides, and purchase/write tools are only registered for valid keys.

- **Keyless admission needs more than a request rate limit:** retained transports make it a resource-exhaustion vector. Enforce a per-IP concurrent-session cap with a pending slot reserved SYNCHRONOUSLY before any await (check-then-act after an await is raceable), swap it for the real sid in `onsessioninitialized`, and release it on every failure/throw path. All teardown goes through one `dropSession` helper so the per-IP index can't leak.
- **Error envelopes differ by protocol:** MCP 401/403 are JSON-RPC envelopes (`error.code`/`error.message`, modeled as `JsonRpcError`/`McpUnauthorized`/`McpForbidden` in openapi.json), but ALL MCP 429s must use the REST `RateLimited` shape (`{error, code, retryAfterSeconds}` + `Retry-After`) to match `applyRateLimit`. Don't mix.

**Why:** an architect review caught both the unbounded-retention DoS and the 429-contract mismatch after the first pass; these are the invariants future MCP changes must preserve.

## Scanning notes

The scanner free tier is **rate-limited per scanned host** (x402-paid otherwise). To get a fresh free result without paying, scan an equivalent alternate host (`milk-market.replit.app` / the custom domain) — same app, separate rate-limit bucket. The platform proxy rewrites `Cache-Control: public` to `private` on responses (not our code) — not the cause of the discovery failure.
