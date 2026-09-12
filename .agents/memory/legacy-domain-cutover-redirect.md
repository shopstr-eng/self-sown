---
name: Legacy-domain cutover redirect
description: milk.market→self-sown.com cutover rules — page traffic 301s to the canonical host; what stays exempt and what a future domain move must preserve
---

# Legacy-domain cutover redirect

- milk.market page traffic 301s to SITE_HOST (path + query preserved; `LEGACY_SITE_HOST` in utils/site-url.ts, block in proxy.ts before the www→apex redirect). Subdomains redirect too. Exempt: `/api/` (Stripe treats 3xx webhook responses as delivery failure) and `/.well-known/` (verification/discovery files must stay reachable) — those fall through and are served as platform traffic because milk.market stays in `PLATFORM_HOST_SUFFIXES`.
- The redirect is guarded by `SITE_HOST !== LEGACY_SITE_HOST`, so deploying it while NEXT_PUBLIC_BASE_URL still points at milk.market is a no-op until the env flips. Port-stripped host compare (a `milk.market:443` Host header must not bypass).
- OAuth `redirect_uri` pinning in `square_oauth_states` / `shipping_oauth_states` is KEPT (decision recorded in __tests__/utils/oauth-redirect-uri-pinning.test.ts): Square/Shippo require the exchange `redirect_uri` to exactly match the authorize-time one, so in-flight flows survive the base-URL flip.
- The discovery-files drift guard keeps milk.market as a local test constant: operational endpoints (/api/*, /.well-known/*) on the retired domain are still flagged as stale cutover drift.
- This redirect was retired once (2026-09-10, legacy traffic had faded) and REINTRODUCED (2026-09-11, user decision) with the same scaffolding. It is time-boxed — retire it again the same way once traffic fades: remove LEGACY_SITE_HOST + the proxy 301 block, keep the suffix entry while the domain is owned, rewrite __tests__/proxy-legacy-host.test.ts.

**Why:** previously-sent email deep links (order confirmations, HMAC-signed review/unsubscribe links, 90-day click TTLs) must keep resolving; webhook senders and domain-verification files can't tolerate 3xx.

**How to apply:** cutover sequencing for any future move — deploy pinning/routing while the OLD base URL is configured, wait >15 min (OAuth state TTL), THEN flip NEXT_PUBLIC_BASE_URL.
