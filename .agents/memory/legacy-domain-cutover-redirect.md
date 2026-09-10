---
name: Legacy-domain cutover redirect (retired)
description: milk.market→self-sown.com cutover rules — the 301 scaffolding is gone; what remains and what a future domain move must preserve
---

# Legacy-domain cutover redirect (retired)

- The post-cutover 301 block and `LEGACY_SITE_HOST` are REMOVED (legacy traffic had faded). milk.market stays in `PLATFORM_HOST_SUFFIXES` in proxy.ts as a string literal — still owned and pointing at the deployment — so old links serve platform traffic instead of the "Domain Not Configured" placeholder. Remove the entry only if the domain is dropped.
- OAuth `redirect_uri` pinning in `square_oauth_states` / `shipping_oauth_states` was KEPT (decision recorded in __tests__/utils/oauth-redirect-uri-pinning.test.ts): harmless, existing rows may still carry pinned URIs, and it protects any in-flight flow from base-URL changes.
- The discovery-files drift guard keeps milk.market as a local test constant: operational endpoints (/api/*, /.well-known/*) on the retired domain are still flagged as stale cutover drift.

**Why:** Stripe treats any 3xx webhook response as a delivery failure and Square/Shippo require the exchange `redirect_uri` to exactly match the authorize-time one — those constraints outlived the redirect itself. Serving (not redirecting) the old domain only works while the domain is owned; the suffix entry is the guard against "Domain Not Configured".

**How to apply:** a future domain move should re-introduce a time-boxed 301 (port-stripped host compare, destination built from the configured canonical origin, /api/ + /.well-known/ exempt) plus OAuth redirect_uri pinning, then retire it the same way once traffic fades. Cutover sequencing: deploy pinning/routing while the OLD base URL is configured, wait >15 min (OAuth state TTL), THEN flip NEXT_PUBLIC_BASE_URL.
