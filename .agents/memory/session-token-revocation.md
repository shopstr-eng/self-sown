---
name: Assistant session token revocation
description: Per-seller kill switch for stateless HMAC session tokens — pro_settings stamp checked in the shared bearer preamble; revoke is never entitlement-gated; stamp reads fail closed.
---

The assistant session tokens are stateless HMAC, so targeted revocation works via a per-seller "revoked before <ts>" stamp in pro_settings (no new table), compared against the token's issued-at in the shared bearer preamble (session-auth.ts) — never in per-route code.

**Why:** the only alternative kill switch is rotating SESSION_SECRET, which logs out every seller at once. A per-seller stamp gives a leaked-token response without a global logout.

**How to apply:**

- Any NEW endpoint accepting these tokens must go through the shared async bearer preamble (session-auth.ts) so the revocation check applies; never call the sync verify util directly from a route.
- Revocation-style safety actions must NOT be gated on Pro/entitlement — a lapsed seller must still be able to kill a leaked token.
- The stamp lookup fails closed: a DB error rejects the request (503), never treats the outage as "not revoked". Null means genuinely no stamp.
- The stamp must advance in ONE atomic upsert (INSERT ... ON CONFLICT ... GREATEST) — a read-modify-write lets an older in-flight revoke overwrite a newer stamp and silently re-validate killed tokens. A corrupt non-numeric stamp folds to 0 so it can't wedge the kill switch.
- Routes must propagate the preamble's status (bearer failures can be 503, not always 401) or outages look like bad tokens.
