---
name: Platform stall URLs permanently redirect to verified custom domains
description: Policy decision and gating contract for the platform-host → custom-domain storefront redirect.
---

# Platform stall → custom-domain redirect policy

Decided policy for search-ranking consolidation: the platform stall pages
permanently redirect (HTTP 308) to the seller's custom domain instead of
merely emitting a canonical link, when the seller has one.

**Why:** serving identical content on both hosts with different canonicals
split search ranking; canonical-only is a hint, a permanent redirect is the
consolidating signal, and it matches the standing "verified custom domain
always wins" rule used by every link surface.

**How to apply — the redirect gate is STRICTER than the share-link rule:**
- Redirect only when the domain is verified AND tls_status is "active"
  (certificate live) AND the seller's membership is not hidden. DNS
  verification precedes certificate provisioning by up to ~24h and
  provisioning can fail; a verified-only redirect strands visitors on a TLS
  error. Hidden sellers' domains stop resolving entirely.
- Never redirect a request already served on the custom domain or a
  self-host tenant (loop).
- The domain lookup must fail OPEN (no redirect) on error — the platform
  page is always a valid response.
- Redirects strip the /stall/<slug> prefix (custom domains are root-mapped)
  and preserve the query string verbatim.
- Share links intentionally keep the looser verified-only bar; do not
  "unify" the two gates.
