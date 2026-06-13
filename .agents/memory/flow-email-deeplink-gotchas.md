---
name: Flow email deep-link gotchas
description: Two non-obvious constraints when adding signed deep-links (e.g. {{review_link}}) to custom email flows.
---

# Tracked-link TTL caps any inner deep-link TTL

Every http(s) link in a rendered flow email is rewritten through the click-tracking
redirect (`rewriteFlowEmailLinks` → `/api/email/flows/click`). That outer click
token has its own TTL (currently 90 days in `flow-link-tracking.ts`). When the
token expires, the click endpoint redirects to the platform SAFE_FALLBACK, not the
intended destination.

**Rule:** a separately-signed deep-link token carried _inside_ a flow-email URL
(e.g. the review token in `/orders?review=<t>`) must keep its TTL in lockstep with
(≤) the click TTL. A longer inner TTL is a dead promise — the wrapped link stops
resolving when the click token expires, silently.

**Why:** review links are always wrapped (they're http to the orders dashboard), so
they're always click-capped. A 180-day review token behind a 90-day click wrapper
effectively dies at 90 days.

**How to apply:** if you change the click TTL or add a new wrapped deep-link, align
the inner token TTL and don't advertise a longer lifetime than the wrapper allows.

# Deep-link auto-open must bind order to the token's seller

`orderId` is NOT globally unique across sellers. When a signed deep-link auto-opens
or pre-fills a buyer modal by matching a decrypted order, match on `orderId` **and**
the order's seller: `order.sellerPubkey || order.productAddress.split(":")[1]` must
equal the token's `sellerPubkey` (productAddress alone may be absent on some tokens).

**Why:** without the seller bind, an order-id collision across sellers can open the
review modal for the wrong seller's order (integrity, not auth — posting still needs
the buyer's own Nostr signature).

**How to apply:** any future "open X for this order from a link" effect should bind
seller (and product when present), and only set the once-guard after a conclusive
match/reject so it can retry as orders decrypt in.
