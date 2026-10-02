---
name: Cashu real-SDK test harness
description: How to drive the real @cashu/cashu-ts Wallet in Jest with an in-test mint that actually signs — quirks that cost time to rediscover.
---

# Cashu real-SDK test harness

Real-SDK regression suites (x402 melt-quote, melt-exec) stub ONLY `safeFetch` and run the real `Mint`/`Wallet`/`safeMeltProofs` over protocol-shaped responses. The stub mint generates its own keys at runtime via the SDK's own `createNewMintKeys(pow2height)` and signs with `createBlindSignature` + `createDLEQProof`, so blind-signature and DLEQ verification genuinely execute and SDK drift fails loudly.

Non-obvious quirks (verified by digging the minified bundle + runtime scratch):

- `verifyUnblindedSignature({secret, C}, privKey)` expects `C` as a **Weierstrass Point** (`pointFromHex(...)`), not a hex string — passing hex crashes with "Weierstrass Point expected". The wire/proof `C` field is hex; convert before verifying.
- NUT-08 change blanks the wallet sends are **amount-0** outputs; the mint assigns the change amounts and returns ≤ blanks count of signatures, paired to blanks **by array index**.
- Melt response is the quote shape PLUS `payment_preimage` + `change: [{amount, id, C_, dleq:{e,s}}]`; the SDK merges it over the quote, so the preimage lands on `meltResponse.quote.payment_preimage`.
- `createNewMintKeys` returns `privKeys`/`pubKeys` as `Uint8Array` maps keyed by amount string; `serializeMintKeys(pubKeys)` gives the hex map to serve at `/v1/keys`.
- Client-side wallet paths (wallet-mint-sync) build UNGUARDED wallets whose transport is the global `fetch` — stub that boundary (jsdom has no fetch to spyOn; assign it outright), not safeFetch.
- `OutputData` P2PK secrets come back with the lock pubkey **compressed** (`02` + x-only) even when you pass an x-only pubkey — compare `data.slice(2)` or accept both forms, as escrow-payout's own comparator does.
- NUT-04 (receive/top-up) stubs must serve a REAL decodable bolt11 invoice in the quote's `request` field: the wallet's `assertBolt11MintQuoteAmount` re-decodes it and requires invoice msat == quote amount × 1000. A placeholder string fails inside the SDK, not at an assertion. Reuse the melt suites' 25-sat fixture. Also unlike NUT-08 change blanks (amount-0), mint outputs carry REAL amounts summing to the quote amount.

**Why:** mocked SDK tests stay green when the SDK renames fields (see cashu-ts-v4-live-requirements); the whole point of these suites is catching drift, which requires real signatures.

**How to apply:** when a new Cashu SDK-consumption path needs a drift guard, copy the harness in `__tests__/mcp/x402-tools-melt-exec-sdk.test.ts` rather than re-deriving the signing plumbing.
