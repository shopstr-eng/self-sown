---
name: Paywalling a feature must gate every sibling endpoint serving the same data
description: When you put a feature behind a paid tier, the named endpoint/UI is not the whole attack surface — find every sibling read path that exposes the same data class.
---

When asked to put an existing feature behind a paid tier (or behind auth), gating
only the one endpoint/tab named in the request is almost never sufficient. The same
underlying data class is usually reachable through one or more sibling read
endpoints that grew up alongside it under a looser convention.

**Why:** Email analytics had a primary stats endpoint AND a separate
engagement/click-stats sibling. The sibling followed the older "open, keyed by
`?seller_pubkey=`, no NIP-98" listing convention, so it was simultaneously a paywall
bypass _and_ a cross-seller data leak (any third party could read any seller's
aggregate click counts + last-click dates). Gating only the named endpoint left the
feature trivially reachable.

**How to apply:** Before declaring a paywall/auth task done, grep the feature's API
area for every route that touches the same data class (e.g. the DB accessor:
`getFlowClickStats`, `getEmailFlowStatsForSeller`, …) and check each for the same
gate. Distinguish READ endpoints (must be gated) from recipient-facing TRACKING
WRITE endpoints (pixel `open`, redirect `click`) which must stay public. When you
gate a previously-open `?seller_pubkey=` read endpoint, switch it to serve only
`authResult.pubkey`'s own data (drop the query param) — NIP-98 here signs the full
URL incl. query (`verifyNip98Request` compares `origin+req.url`), so the client must
sign a query-less URL and the server must not depend on the param. Update the
consumer to send the signed `Authorization` header and only fetch when entitled.
