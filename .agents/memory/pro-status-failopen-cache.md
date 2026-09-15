---
name: Pro-status transient-failure policy
description: Storefront pro-status gating must distinguish definitive isPro:false (fail closed) from transient fetch failures (retry + last-known-good cache) — don't regress to fail-closed-on-any-error.
---

# Pro-status transient-failure policy

Storefront premium styling is gated on `/api/pro/status`. The resolution must
treat two failure kinds differently:

- **Definitive answer (HTTP 200 with isPro:false)** → fail closed immediately;
  this also overwrites the cache so a lapse is enforced the moment the
  endpoint is reachable again.
- **Transient failure (network error, non-OK status)** → bounded retry with
  backoff, then fall back to a last-known-good entitlement cached per seller
  pubkey (localStorage, TTL-bounded), only failing closed when no fresh cache
  exists.

**Why:** a dev DB outage silently reverted every Pro storefront to default
fonts/colors (user-reported as "custom fonts broken"), while the original
fail-closed behavior existed to stop lapsed sellers keeping their design. Both
properties matter; neither alone is correct.

**How to apply:** the policy lives in the shared
`useStorefrontProEntitlement` hook — reuse it (or mirror its semantics) for any
new surface that gates rendering on pro status. Cache reads must stay
pubkey-scoped so a seller switch never inherits another seller's entitlement,
and TTL bounds how long an outage can extend a lapsed seller's styling.
