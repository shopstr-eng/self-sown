---
name: Shippo label-charge reconciliation
description: Shippo transactions have no shipment field and a 100-char metadata cap — reconcile ambiguous label charges via a stamped sha256 token, never by shipment id or claim key.
---

Shippo Transaction payloads carry **no shipment id**; the only caller-controlled handle on a transaction is `metadata` (string, **100-char limit**). Raw claim keys (`outbound:<64-char pubkey>:<orderId>`) exceed that limit.

**Why:** an accepted-but-lost purchase POST (timeout after Shippo accepted) must be reconcilable before any retry, or retries double-charge the seller. Mocked tests happily match on invented fields (`tx.shipment`) that the real API never sends.

**How to apply:**
- Stamp `buildLabelReconcileToken(claimKey)` (sha256 hex, 64 chars) into the buyLabel POST `metadata`, and persist the SAME token on every claim row for that attempt (order claim AND payment claim) via attachShipmentToClaim/claimAutoLabelPurchase — either claim must be able to reconcile.
- Match transactions by exact `metadata === token`; treat matching WAITING/QUEUED as in-flight (may still become a charge), never as "no charge".
- "No charge" is only trustworthy when the paged scan (newest-first) covered the claim's charge window (reached older object_created or exhausted the list); a page-cap exit is UNKNOWN.
- Attach shipment+token to the claim BEFORE the charge; a missing attach must stop the purchase. Stale null-shipment claims are crash orphans — safe to release after the in-flight window (~2 min).
