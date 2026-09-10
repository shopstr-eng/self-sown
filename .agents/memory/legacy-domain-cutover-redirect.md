---
name: Legacy-domain cutover redirect
description: Rules the milk.market→self-sown.com cutover redirect established — any future domain move or proxy host-routing change must preserve them
---

# Legacy-domain cutover redirect

- The legacy host (`LEGACY_SITE_HOST`, a historical constant that never follows env) stays in `PLATFORM_HOST_SUFFIXES` — it is never treated as a seller custom domain, so `/api/` keeps working on it.
- Page traffic on the legacy host 301s to `SITE_HOST` with path+query preserved; the Host comparison is port-stripped and the destination is built from the configured canonical origin (scheme/host/port), never from the incoming request URL.
- `/api/` and `/.well-known/` NEVER redirect.
- OAuth callback pages (Square/Shippo) DO redirect; continuity is preserved by pinning the authorize-time `redirect_uri` in the OAuth state row (`square_oauth_states` / `shipping_oauth_states`) and replaying it at token exchange instead of reconstructing from the current base URL.

**Why:** Stripe treats any 3xx webhook response as a delivery failure, and NIP-05 / Apple Pay / agent-discovery files must stay reachable on the old domain during transition. Square/Shippo require the exchange `redirect_uri` to exactly match the authorize-time one.

**How to apply:** any change to proxy.ts host routing must keep the `/api/` + `/.well-known/` exemption; any new OAuth-style provider must pin `redirect_uri` in its state row the same way. Cutover sequencing: deploy the pinning/routing code while the OLD base URL is still configured, wait >15 min (the OAuth state TTL) so unpinned legacy state rows expire, THEN flip NEXT_PUBLIC_BASE_URL and publish again — simultaneous code+domain flip leaves a ~15-min window where in-flight OAuth connects fail once (seller retries).
