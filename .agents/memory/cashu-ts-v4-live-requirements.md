---
name: cashu-ts v4 live-only API requirements
description: Mocked wallet tests hide three cashu-ts v4 runtime requirements — v2 keyset-id decode needs the mint's keysets, every wallet op needs loadMint, receive() rejects unit-less token objects
---

cashu-ts v4 enforces three things at runtime only; the type signatures allow
the broken shapes and mocked wallets never enforce them, so a green unit suite
says nothing:

1. `getDecodedToken(token, [])` throws on v2 (0x01-prefixed) keyset IDs, which
   Nutshell ≥0.20 and testnut issue: fetch the mint's `/v1/keysets` and pass
   the id list to the decode instead.
2. Any op on a bare `new CashuWallet(new CashuMint(url))` throws "KeyChain not
   initialized" until `loadMint()` has run.
3. `wallet.receive(tokenObj)` strictly compares units: a token object without
   `unit` throws "Token is not in wallet unit" — thread the decoded token's
   unit through.

**Why:** each of these broke a different stage of the same live flow while
every mocked test passed; they are invisible without a real mint.
**How to apply:** smoke any new cashu-ts wallet/mint interaction once against
a real mint (a local Nutshell FakeWallet mint suffices) before shipping; for
new decode/receive code, copy the existing escrow decode/receive call shapes
rather than the minimal signature.

A fourth live-only behavior (found 2026-09): `wallet.send(amount, proofs)`
SHORT-CIRCUITS when `amount` exactly equals the inputs' total — no swap, the
inputs stay UNSPENT at the mint. Any test fixture that needs proofs marked
SPENT must send a partial amount to force the swap. The boot-cleanup contract
test (`utils/nostr/__tests__/fetch-service-real-mint.test.ts`, gated on the
staging mint, port 3338) does exactly this.
