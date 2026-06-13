---
name: Order participants not server-readable
description: Why getOrderParticipants returns null in production and what server-trusted order data actually exists
---

# Order data is encrypted; the server cannot resolve order participants

Order messages are NIP-17 gift wraps cached in `message_events` as kind-1059
events. Their tags are only `[["p", recipientPubkey]]` — there is **no
cleartext `b` (buyer), `a`/`item` (seller), `order` id, or `buyer_email` tag**.
In production, `message_events.order_id` is `NULL` for every row.

**Consequence:** `getOrderParticipants(orderId)` (which reads `order_id` + `b`/`a`
tags from `message_events`) returns `{ buyerPubkey: null, sellerPubkey: null }`
for essentially all real orders. Any endpoint that _hard-requires_ a resolved
seller/buyer from this function (e.g. a 404/403 gate) will block 100% of real
traffic. `update-order-status` has this same latent issue but masks it because
its client calls are fire-and-forget.

**How to apply:** Never gate order endpoints on `getOrderParticipants` resolving.
Treat it as best-effort: only enforce ownership _when_ it resolves; never reject
on the (normal) null case.

## Order-status persistence is client-stamped (it was 100% dead)

`message_events.order_id` is never written at cache time (`cacheEvent` only
inserts id/pubkey/created_at/kind/tags/content/sig), yet every status query
(`getOrderParticipants`, `updateOrderStatus`, `getOrderStatuses`) keys on
`order_id`. So status writes matched 0 rows and reads returned nothing — the
seller's "shipped" reverted to "pending" on refresh (the shipping gift wrap is
addressed to the BUYER, so the seller's own relay view never re-derives it).

**Fix shape:** the client must send `messageId` = the **gift-wrap id**, which is
`message_events.id`. On the message objects this is `wrappedEventId`, NOT `.id`
(`.id` is the decrypted _rumor_ id; only kind-1059 wraps are cached to Postgres).
`updateOrderStatus` locates the row by that id, **stamps `order_id`** and sets
`order_status` in one UPDATE (guard `order_id IS NULL OR order_id = $orderId`),
authed by the `p`-tag (gift-wrap `pubkey` is ephemeral). The read side then finds
it because the stamped `order_id` (= `orderTag || rumorId`) is always one of the
`getOrderStatusLookupKeys`.

**Why:** gift-wrap content is encrypted, so the server can never populate
`order_id` itself — the client is the only party that knows the wrap↔order map.

**Caveat:** because participants almost never resolve, the role matrix
(seller-only "shipped", buyer-only "canceled") is effectively bypassed; any
authenticated `p`-tag recipient of a wrap can set any valid status for that order.
Accepted: keys live in encrypted content (unguessable), NIP-98 + rate limits +
the re-stamp guard bound the blast radius.

## What order data IS server-trusted

- `notification_emails` (keyed by `order_id`, role `buyer`/`seller`) — written at
  checkout by `send-order-email` from the buyer's browser. This is the only
  server-side buyer-email source. It's self-asserted (the unauthenticated
  `send-order-email` endpoint accepts any orderId+email), but adequate because
  the buyer is emailing themselves.
- The buyer's email otherwise lives only in the encrypted order's `buyer_email`
  tag, visible to the seller client-side (e.g. orders-dashboard
  `selectedOrder.buyerEmail`), NOT to the server.

## Email-relay posture

`send-order-email` has **no auth** (rate-limit only) — it's already an open relay
for order-confirmation emails to arbitrary addresses. So requiring NIP-98 + per
-pubkey/per-IP rate limits on order-update email (send-update-email) is stricter
than the existing peer endpoints. Branding for outbound order email must use the
authenticated pubkey, never a body-supplied sellerPubkey (brand-spoofing).
