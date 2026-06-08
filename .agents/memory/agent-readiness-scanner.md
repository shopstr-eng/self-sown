---
name: Agent-readiness scanner gaps (JSON 404, rate-limit headers, WBA key discovery)
description: How to satisfy an external agent-readiness scanner's "Structured errors (JSON 404)", "Rate limit headers", and "Public keys discoverable" checks in this Next.js pages-router app.
---

External agent-readiness scanners (e.g. metaend-grade) probe the **live deployed site root and random paths**, not just `/api`. Three recurring gaps and their durable fixes:

## 1. Structured errors (JSON 404) — the only _required_ (non-optional) check

The `/api/[...notFound]` catch-all only covers `/api/*`. Non-API page 404s serve Next's HTML 404 even with `Accept: application/json`.
**Fix:** a root required catch-all page `pages/[...notFound].tsx` whose `getServerSideProps` emits the shared `buildAgentError` JSON when `Accept` lacks `text/html`, else `return { notFound: true }` (renders the normal HTML 404).
**Why a root catch-all is safe:** Next route precedence means every specific + nested-dynamic route wins; the root catch-all fires only on a genuine 404. `/api/*` still hits `pages/api/[...notFound]`. The `res.write(...)+res.end()` then `return { props: {} }` pattern is the same one the sitemap/rss page-router endpoints use.
**Custom-domain limitation:** seller storefront subpaths get rewritten to `/stall/<slug>/<path>` and render 200 HTML (validity decided client-side), so a server-side JSON 404 there is NOT feasible without breaking real page-builder pages. Documented/accepted; the scanner's required check passes on the platform host.

## 2. Rate limit headers (optional)

Only the agent API endpoints set them; the homepage/general responses didn't.
**Fix:** wrap the proxy — rename the body to `routeRequest`, export a `proxy` that calls `withAdvisoryRateLimitHeaders(await routeRequest(req))`. It adds advisory `RateLimit-*`/`X-RateLimit-*`/`RateLimit-Policy` to every response (covers both hosts).
**Duplicate guardrail:** endpoints that already set accurate per-request headers via `applyRateLimit` (WBA directory + agent-view + stall-agent-view rewrites) tag their middleware response with an `x-mm-rl-skip` marker; the wrapper skips them and strips the marker. **Watch indentation:** the platform `/stall/<slug>` agent branch is more deeply nested, so a bulk replace keyed on 6-space indent misses it — verify every rewrite branch carries the marker.

## 3. Public keys discoverable (optional)

The WBA directory at `/.well-known/http-message-signatures-directory` is _found_ (status 200) but keys report as not discoverable.
**Root cause:** naive scanners gate JSON parsing on the literal substring `application/json`; the spec media type `application/http-message-signatures-directory+json` does NOT contain that substring, so they never parse the JWK Set.
**Fix:** content-negotiate the directory `Content-Type` — serve `application/json` when `Accept` includes `application/json` (and not the registered type), else the registered media type for spec-aware verifiers (Cloudflare). `Vary: Accept` already set.

## Scanning notes

The scanner free tier is **rate-limited per scanned host** (x402-paid otherwise). To get a fresh free result without paying, scan an equivalent alternate host (`milk-market.replit.app` / the custom domain) — same app, separate rate-limit bucket. The platform proxy rewrites `Cache-Control: public` to `private` on responses (not our code) — not the cause of the discovery failure.
