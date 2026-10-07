---
name: Two label-purchase claim systems coexist deliberately
description: Web auto-purchase uses claimKey-based claims with reconcile tokens; manual/mobile purchases use purchaseOutboundLabel with (pubkey, orderId) dual-write claims — they dedup via the shared legacy table key format.
---

After merging the mobile shipping work, TWO outbound-label claim systems exist:

1. **claimKey-based** (`claimAutoLabelPurchase`, `getAutoLabelClaim`, `releaseAutoLabelClaim`, `markAutoLabelPurchased`, `attachShipmentToClaim` in utils/db/shipping-service.ts) — used by main's web auto-purchase (utils/shipping/auto-purchase.ts), with payment-bound (`payment:<seller>:<ref>`) AND order-bound (`outbound:<seller>:<orderId>`) dual claims plus reconcile tokens.
2. **Outbound-claim** (`claimOutboundLabelPurchase`, `releaseOutboundLabelClaim`, `markOutboundLabelPurchased` + utils/shipping/outbound-label-purchase.ts) — used by the manual buy-label route (web + mobile NIP-98). Dual-writes shipping_outbound_order_claims AND legacy shipping_label_order_claims with claim_key = paymentRef || `outbound:<pubkey>:<orderId>`.

**Why:** the mobile PR predated main's reconcile-token layer; taking either side wholesale would have regressed the other. Cross-flow double-charge protection works because BOTH systems' order-bound claims land on the SAME legacy key format `outbound:<pubkey>:<orderId>` — never change one side's key format without the other.

**How to apply:** new purchase paths should go through `purchaseOutboundLabel` (it stamps the reconcile token and reconciles claim conflicts before charging). `releaseOutboundLabelClaim(pubkey, orderId)` deletes ALL pending legacy claims for that order — do not call it while a claimKey-based payment-bound claim for the same order must survive.
