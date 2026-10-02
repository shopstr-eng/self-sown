---
name: x402 settlement invariants
description: ordering and failure-reporting rules for the x402 lnbtc settlement path that took multiple adversarial review rounds to get right
---

The x402 payment paths (pages/api/mcp/verify-payment.ts polling,
pages/api/mcp/create-order.ts preimage settlement, mcp/tools/x402-tools.ts
buyer tool) obey invariants that were each produced by an adversarial review
round — preserve them when editing:

1. Receipt BEFORE reap: the x402 settled-payment receipt (claimX402Settlement)
   must be committed before the settlement tail deletes the pending quote row.
   If the insert throws, abort without settling — the quote survives for retry.
   A crash between reap and insert strands a paid order with neither quote nor
   receipt; every later retry 402s unknown_payment_hash.
2. A completed melt is `paid: true` FOREVER: merchant acknowledgement failures
   (transport exception OR non-2xx) must surface as paid-but-unacknowledged
   carrying preimage + paymentHash + the encoded PAYMENT-SIGNATURE header and
   "do NOT pay again" retry guidance. Never let a downstream error mask a
   settled payment as a generic failure.
3. Wallet accounting runs on EVERY paid outcome (even preimage-missing), and
   the deletion of spent kind-7375 events is gated on postcondition checks:
   confirm the replacement event is cached (cacheEvent swallows write errors),
   and after deleteCachedEventsByIds (which also swallows) re-read and fail
   loudly via walletPersistError if any spent event survives.

**Why:** each rule closed a money-losing hole a reviewer reproduced with fault
injection (crashed settlement, masked payment, silently re-spent proofs).
**How to apply:** any change to these three files or to
utils/mcp/lightning-settlement.ts / utils/db/x402-service.ts must keep the
ordering; the fault tests in **tests**/mcp/x402-tools.test.ts pin rules 2–3.
