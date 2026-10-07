---
name: Label-purchase claims — never constrain (pubkey, order_id)
description: shipping_label_order_claims must allow MULTIPLE rows per (pubkey, order_id); the card auto-purchase flow holds a payment-bound and an order-bound claim for the same order simultaneously.
---

The card auto-purchase flow intentionally takes TWO rows in
shipping_label_order_claims per order: a payment-bound replay guard
(`payment:<seller>:<ref>`) and the order-bound guard
(`outbound:<seller>:<orderId>`) shared with the manual/mobile purchase route.

**Why:** a Phase 5 migration once added a (pubkey, order_id) dedup DELETE +
unique index; it broke auto-purchase's second claim and silently deleted
payment-bound replay guards. Per-order uniqueness for the manual/mobile flow
lives on shipping_outbound_order_claims' PRIMARY KEY instead. Mocked tests
can't see this — only real-Postgres tests catch schema/flow conflicts (see
the SHIPPING_CLAIMS_TEST_DATABASE_URL-gated live suite).

**How to apply:** never add uniqueness or dedup keyed on (pubkey, order_id)
to the legacy claims table; the cross-flow dedup contract is the shared
`outbound:<pubkey>:<orderId>` claim-key format. Also: the mobile Shippo OAuth
redirect must use the app's FIRST configured scheme (selfsown://), matching
Linking.createURL in the app.
