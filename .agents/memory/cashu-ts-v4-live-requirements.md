---
name: cashu-ts v4 live-only API requirements
description: Mocked wallet tests hide cashu-ts v4 runtime requirements — v2 keyset-id decode needs the mint's keysets, every wallet op needs loadMint, receive() rejects unit-less token objects, proof amounts decode as Amount instances that serialize as strings
---

cashu-ts v4 enforces four things at runtime only; the type signatures allow
the broken shapes and mocked wallets never enforce them, so a green unit suite
says nothing:

1. `getDecodedToken(token, [])` throws on v2 (0x01-prefixed) keyset IDs, which
   Nutshell ≥0.20 and testnut issue: fetch the mint's `/v1/keysets` and pass
   the id list to the decode instead. When the caller can't know the mint
   ahead of time (paste-a-token flows), `getTokenMetadata(token)` parses the
   envelope WITHOUT keyset mapping — use it to find the mint; never hand-parse
   the CBOR.
2. Any op on a bare `new CashuWallet(new CashuMint(url))` throws "KeyChain not
   initialized" until `loadMint()` has run.
3. `wallet.receive(tokenObj)` strictly compares units: a token object without
   `unit` throws "Token is not in wallet unit" — thread the decoded token's
   unit through. Decoding a unit-less token (e.g. Send's
   `getEncodedToken({mint, proofs})`) yields `unit: "sat"` by default, so no
   `?? "sat"` fallback is needed after decode.
4. Decoded proof `amount` fields are Amount instances that JSON-serialize as
   strings: naive `sum + (p.amount || 0)` concatenates ("0"+"100" = "0100")
   and `.toNumber()` throws on the stored string form — coerce every amount
   through an explicit number conversion before summing.

**Why:** each of these broke a different stage of the same live flow while
every mocked test passed; they are invisible without a real mint.
**How to apply:** smoke any new cashu-ts wallet/mint interaction once against
a real mint (a local Nutshell FakeWallet mint suffices) before shipping; for
new decode/receive code, copy the existing escrow decode/receive call shapes
rather than the minimal signature.

A fifth live-only behavior (found 2026-09): `wallet.send(amount, proofs)`
SHORT-CIRCUITS when `amount` exactly equals the inputs' total — no swap, the
inputs stay UNSPENT at the mint. Any test fixture that needs proofs marked
SPENT must send a partial amount to force the swap.

A sixth (found 2026-09): the escrow payout WORKER is stricter than the escrow
ENDPOINTS about the Amount-serializes-as-string issue (#4). Endpoints coerce
`Number(p.amount)`; the worker's `assertPayloadShape` fails closed on
`typeof amount !== "number"` → "malformed proof" after finalization. Any new
client of the escrow endpoints must normalize Amount instances to plain
numbers BEFORE JSON-serializing proofs, or the payout leg poisons its outbox
row with a permanently-failing payload.
