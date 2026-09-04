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

**How to apply:** Never gate order endpoints on `getOrderParticipants` resolving,
but never treat the normal null result as permission either. Any role-sensitive
server action needs a separate server-trusted order ledger that binds the order
ID to authenticated buyer and seller identities.

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

**Security rule:** because participants almost never resolve, falling back to the
outer gift-wrap `pubkey` or `p` tag does not establish an order role. An attacker
can create a correctly signed kind-1059 wrap, control its ephemeral author, and
choose its recipient; client-stamping a known order ID then turns that untrusted
metadata into a forged status record. NIP-98, rate limits, and a re-stamp guard
do not fix the missing order-to-role binding.

**Why:** encryption prevents the server from learning roles from the cached wrap,
while the cleartext outer event fields are attacker-selected routing metadata.

**How to apply:** Persist a server-trusted order record at order creation that
binds the order ID to buyer and seller pubkeys. Authorize status changes against
that record and enforce sequential transitions with an atomic compare-and-set.

## seller_order_states init must stay seller-only (buyer-cancel squat vector)

`transitionSellerOrderStatus` only lets the SELLER initialize a state row
(actorPubkey === sellerPubkey). A "buyer can cancel their own pending order
before the seller opens it" variant was tried (self-declared buyerPubkey +
known wrap id) and **reverted**: gift-wrap ids and their p-tags are publicly
observable on relays, so wrap-id knowledge is not authorship proof, and the
buyer key is attacker-controlled. An attacker could init a `canceled` row for
an observed wrap, squatting the `UNIQUE (seller_pubkey, source_message_id)`
slot so the REAL order can never be initialized (insert no-ops on conflict).

**Why:** code review caught this as broken access control / fulfillment DoS;
pre-open buyer cancel is deferred until a server-verifiable buyer↔order
binding exists at order creation.

**How to apply:** do not re-add buyer-side init to `transitionSellerOrderStatus`
(or sibling init paths) from caller-supplied buyer identity. The regression
test (squat attempt → forbidden, no row, seller can still init the same wrap)
lives in the testcontainers suite in `utils/db/__tests__/db-service.test.ts`
(RUN_TESTCONTAINERS-gated — only enforced when run against a real DB).

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
