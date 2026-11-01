---
name: Mobile PoS (point of sale)
description: design contracts for the mobile PoS tab — self-addressed order events, per-line orders, Stripe Terminal beta API drift, Square payment-link rail
---

Mobile PoS (apps/mobile/app/(tabs)/pos, libs in apps/mobile/lib/pos-*) records in-person sales as ordinary order events so both Orders tabs pick them up unchanged.

- **PoS orders are seller-authored kind:14 rumors gift-wrapped to the seller's OWN pubkey** (recipient == author). parseSellerOrderMessage accepts this: buyerPubkey resolves to event.pubkey, isGuest via buyer_type tag. createSellerOrderStatusGiftWrap rejects self-address; use createSellerPosOrderGiftWrap (packages/nostr) instead.
- **One order event per cart line.** consolidateSellerOrders groups by orderId but mergeMessageIntoOrder rejects messages whose productAddress conflicts — a multi-item sale can never share one orderId. PoS uses `<saleId>-<lineIndex>` ids.
- **PoS sales advance status server-side pending→confirmed→shipped→completed** (three chained updateOrderStatus calls; direct jumps rejected). The rumor's own ["status","completed"] tag is informational only — the parser hardcodes pending and the server store is authoritative.
- **Bulk tiers are applied greedily at the register** (largest fitting bundle first, remainder at base) in packages/domain/src/pos.ts; tier semantics are ["bulk", units, TOTAL bundle price], and tiers priced >= base are ignored.

**Why:** online-order format parity keeps web/mobile Orders, email receipts, and the MCP order surface working for PoS with zero new parsing surfaces.

**How to apply:** any change to the order-event tag contract must update buildPosOrderRumorParts (domain) — the nostr signer consumes it, and the nostr roundtrip test parses through the real pipeline.

Card rails:
- **Stripe = Tap to Pay via @stripe/stripe-terminal-react-native (beta.34), lazy-required** (absent from web export and old dev clients — never static-import it). beta.34 contract: StripeTerminalProvider requires `localeConfig`; discoverReaders returns only {error} (readers arrive via the useStripeTerminal `onUpdateDiscoveredReaders` callback); connectReader takes ONE param object and Tap to Pay requires a `locationId` (fetched via getLocations; seller must have a Terminal location on the connected account).
- **iOS Tap to Pay needs Apple's com.apple.developer.proximity-reader.payment.acceptance entitlement**, granted per developer account — deliberately NOT in app.config entitlements until approved (provisioning would fail). Android needs only the NFC/bluetooth/location permissions already declared.
- **Square = hosted quick_pay payment link + QR** (createSquarePaymentLink in utils/square/square-api.ts, routes /api/square/pos-link[-status]); paid detection = order state COMPLETED or a CAPTURED tender. No viable React Native Square tap-to-pay binding exists — don't chase one without checking Square's Mobile Payments SDK maturity first.
- All PoS server routes are NIP-98-authed and resolve the seller's connected account server-side from the authed pubkey (never from the request body).
