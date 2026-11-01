---
name: www canonical host + edge redirect quirks
description: www.self-sown.com DNS/deployment setup state, and the verified fact that the edge's http→https 301 adds a :443 port (not app code)
---

# www.<canonical> host setup + edge redirect quirks

- The Replit deployment already serves multiple custom domains (apex + others
  as additionalUrls), so `www.self-sown.com` only needs (1) adding under
  Publishing → Domains and (2) a registrar DNS record — no app change for
  routing. proxy.ts already 301s `www.<SITE_HOST>` → apex (hardened
  2026-10-31: port-stripped host compare + destination built from the SITE_URL
  origin, because the internal request scheme is http behind the edge and a
  scheme-preserving redirect would emit an http:// Location).
- Registrar gotcha (Namecheap): `www` had a Namecheap "URL Forward" A record
  (162.255.119.x) that answers ONLY plain http with a 302 to the bare apex —
  no path/query preserved, and https://www. times out entirely (no TLS). It
  must be deleted when adding the real record; "a DNS record exists" did not
  mean "www works".
- The http→https upgrade redirect on the apex issues
  `Location: https://self-sown.com:443/...` (explicit :443 port). Verified
  2026-10-31 to be Replit edge (Google Frontend) behavior, NOT app code: the
  301 fires for /api/\* too, which the app never redirects, and carries no app
  headers. Not fixable app-side; harmless (browsers normalize :443 on https).

- Seller custom domains: `www.<seller-domain>` 301s to the bare domain — but
  the proxy only ever runs if the seller's DNS has a www record AND the
  platform terminates TLS for www.<domain>. Most sellers only point their
  apex, so buyers can still dead-end at the DNS/TLS layer before any redirect.

**Why:** future domain/audit reports about "www dead end" or ":443 in the
Location header" should start here instead of re-deriving where each header
comes from.

**How to apply:** for any new host that should reach the app: add it in
Publishing → Domains first, then point DNS at what Replit shows; check
registrar "URL redirect/parking" records separately — they shadow real
records and break TLS.
