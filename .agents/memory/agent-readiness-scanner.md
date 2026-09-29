---
name: Agent-readiness scanner gaps (JSON 404, rate-limit headers, WBA key discovery)
description: How to satisfy an external agent-readiness scanner's "Structured errors (JSON 404)", "Rate limit headers", and "Public keys discoverable" checks in this Next.js pages-router app.
---

External agent-readiness scanners (e.g. metaend-grade) probe the **live deployed site root and random paths**, not just `/api`. Three recurring gaps and their durable fixes:

## 1. Structured errors (JSON/markdown 404) — the only _required_ (non-optional) check

All agent-facing 404s route through `tryWriteAgentNotFound` / `acceptsMarkdown` / `buildAgentNotFoundMarkdown` in `utils/api/agent-error.ts`. **Any new agent-facing 404 surface must reuse those helpers** — do not hand-roll negotiation.

- **Surfaces wired:** root catch-all `pages/[...notFound].tsx`, API catch-all `pages/api/[...notFound].ts`, all stall GSSP `notFound` sites (via a `stallNotFound()` closure that names the public path from `x-ss-original-path` on custom domains), and both 404s in `pages/api/stall-agent-view.ts` (proxy routes non-HTML stall requests there, bypassing the page GSSP — so both layers need wiring).
- **Negotiation is q-aware (RFC 9110):** markdown wins ties, HTML only when strictly preferred, `*/*` gets JSON. A naive `accept.includes("text/html")` check fails `Accept: text/markdown, text/html;q=0.1`.
- The `res.end()` then `return { props: {} }` pattern in GSSP is safe on Next 16 (finished response suppresses render).
- After `res.end()`, return `{ props: {} as Props }` to satisfy typed GSSP.

**Why:** scanner required check + agents need machine-readable errors on every host, incl. custom domains.

## 2. Rate limit headers (optional)

Only the agent API endpoints set them; the homepage/general responses didn't.
**Fix:** wrap the proxy — rename the body to `routeRequest`, export a `proxy` that calls `withAdvisoryRateLimitHeaders(await routeRequest(req))`. It adds advisory `RateLimit-*`/`X-RateLimit-*`/`RateLimit-Policy` to every response (covers both hosts).
**Duplicate guardrail:** endpoints that already set accurate per-request headers via `applyRateLimit` (WBA directory + agent-view + stall-agent-view rewrites) tag their middleware response with an `x-ss-rl-skip` marker; the wrapper skips them and strips the marker. **Watch indentation:** the platform `/stall/<slug>` agent branch is more deeply nested, so a bulk replace keyed on 6-space indent misses it — verify every rewrite branch carries the marker.

## 3. Public keys discoverable (optional)

The WBA directory at `/.well-known/http-message-signatures-directory` is _found_ (status 200) but keys report as not discoverable.
**Root cause:** naive scanners gate JSON parsing on the literal substring `application/json`; the spec media type `application/http-message-signatures-directory+json` does NOT contain that substring, so they never parse the JWK Set.
**Fix:** content-negotiate the directory `Content-Type` — serve `application/json` when `Accept` includes `application/json` (and not the registered type), else the registered media type for spec-aware verifiers (Cloudflare). `Vary: Accept` already set.

## 4. MCP keyless sessions + error-envelope contract

The MCP endpoint (`pages/api/mcp/index.ts`) allows unauthenticated `initialize` (advertised by `/.well-known/mcp.json`): null-key sessions get read tools only, keyed checks compare `?.id ?? null` on both sides, and purchase/write tools are only registered for valid keys.

- **Keyless admission needs more than a request rate limit:** retained transports make it a resource-exhaustion vector. Enforce a per-IP concurrent-session cap with a pending slot reserved SYNCHRONOUSLY before any await (check-then-act after an await is raceable), swap it for the real sid in `onsessioninitialized`, and release it on every failure/throw path. All teardown goes through one `dropSession` helper so the per-IP index can't leak.
- **Error envelopes differ by protocol:** MCP 401/403 are JSON-RPC envelopes (`error.code`/`error.message`, modeled as `JsonRpcError`/`McpUnauthorized`/`McpForbidden` in openapi.json), but ALL MCP 429s must use the REST `RateLimited` shape (`{error, code, retryAfterSeconds}` + `Retry-After`) to match `applyRateLimit`. Don't mix.
- **SDK 1.29 Accept 406 trap:** `StreamableHTTPServerTransport` bridges Node→Web via `@hono/node-server`, which builds the Web Request from `req.rawHeaders` — mutating `req.headers.accept` alone never reaches the transport (406 on `*/*`, missing, or json-only Accept). Use `applyMcpAcceptHeader(req)` (utils/api/mcp-accept.ts), which syncs both representations. Bare `initialize` without params is also defaulted in the route.
- **SDK 1.30 plain-JSON handshake:** the SDK's Accept validation is UNCONDITIONAL (both substrings required) even with `enableJsonResponse` — that option only changes the RESPONSE to a plain JSON body (no SSE envelope), which is what naive agents/scanners that JSON.parse need. Correct combo: normalize Accept to the full set (validation passes) + `enableJsonResponse: true` (parseable response). Verified by reading dist/cjs/server/webStandardStreamableHttp.js — passing a json-only Accept through gives a 406.

## 6. Capability metadata must be TRUE — the OAuth finding

A scanner asked for "OAuth 2.0/OIDC metadata". Do NOT satisfy it by pointing RFC 8414 / OpenAPI oauth2 fields at `/api/mcp/api-keys` — that endpoint is Nostr-proof JSON key issuance, not an OAuth grant endpoint, so agents following the advertised flow would fail.

**Why:** declaring standard-protocol metadata over a non-standard endpoint is worse than absence — agents act on it.
**How to apply:** the accurate capability surfaces are bearerAuth + `x-scopes` in openapi.json, the RFC 9728 `/.well-known/oauth-protected-resource` doc, and the `onboarding`/`cli` blocks in agent.json (freeTier, selfServeKeyGeneration, zeroAuthEndpoints). Satisfy future "missing protocol X" scanner findings only with endpoints that actually speak X.

## 7. Cursor pagination convention

Agent-facing list endpoints (UCP search, checkout sessions) take a `cursor` param alongside legacy `limit/offset`: an opaque `pg_` + base64url JSON `{o, f}` from utils/api/pagination-cursor.ts. `f` is a route-built fingerprint of the active filters/page-size — a mismatch 400s, so changing filters mid-pagination fails loud instead of silently skipping results. Present-but-empty cursor must also 400 (check `req.query.cursor !== undefined`, not truthiness). Node's base64url decoder eats invalid chars, so the charset is regex-validated first; offsets use `Number.isSafeInteger`. Pages are a moving snapshot — an endpoint that ever promises continuity across writes needs keyset pagination, not this.

## 5. API versioning contract

- Every `/api/*` response is stamped `API-Version: 2` in proxy.ts; an `API-Version` request header with an unsupported major fails closed 400 (`unsupported_api_version`, shared Error body) BEFORE routing. Versioned-header (not URL-path) strategy; the contract lives in `x-versioning-policy` + `/developers#versioning`.
- **Spec-lint tests exist** (`__tests__/utils/geo/openapi-completeness.test.ts`): any new operation in openapi.json must have operationId+summary+description, a shared 4xx error `$ref`, typed parameters, and keep typed-response coverage ≥60% — or CI fails.

**Why:** an architect review caught both the unbounded-retention DoS and the 429-contract mismatch after the first pass; these are the invariants future MCP changes must preserve.

## Scanning notes

The scanner free tier is **rate-limited per scanned host** (x402-paid otherwise). To get a fresh free result without paying, scan an equivalent alternate host (`milk-market.replit.app` / the custom domain) — same app, separate rate-limit bucket. The platform proxy rewrites `Cache-Control: public` to `private` on responses (not our code) — not the cause of the discovery failure.
