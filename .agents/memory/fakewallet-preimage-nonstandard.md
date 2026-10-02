---
name: FakeWallet preimage quirk + x402 restart tests
description: staging Nutshell FakeWallet auto-settles mint quotes and hashes ascii-hex payment secrets (not raw bytes), so its invoices can never pass standard preimage validation; how to test preimage paths anyway
---

Staging Nutshell mint (FakeWallet backend, Staging Cashu Mint workflow)
behavior that shapes Lightning test design:

- Mint quotes auto-settle: `checkMintQuoteBolt11` returns PAID immediately
  after `createMintQuoteBolt11` — no payer action needed (that mint state IS
  the settlement signal production trusts).
- A melt of a mint-issued invoice is refused ("mint quote already paid",
  code 11000), so a real melt cannot produce the preimage of a mint-issued
  invoice.
- FakeWallet computes payment_hash = sha256(ASCII hex of payment_secret),
  NOT sha256(preimage bytes) like real Lightning. Standard validation in
  utils/x402/server.ts (validatePaymentPayload hashes Buffer.from(preimage,
  "hex")) can therefore NEVER pass for a FakeWallet invoice.

**Why:** discovered while building the x402 settlement restart-recovery
staging test; required reading cashu/lightning/fake.py inside the ephemeral
mint venv — not discoverable from repo code alone.
**How to apply:** for tests needing a preimage that validates, self-sign a
bolt11 with the JS `bolt11` package (encode with payment_hash/payment_secret/
description/expire_time tags, sign with key "01"\*32, controlled preimage =
sha256 of its raw bytes). The x402 preimage-settlement route
(handleX402Settlement) never consults the mint — the preimage is the proof —
so a self-signed invoice is faithful there. For mint-polling surfaces
(verify-payment), use the auto-settled FakeWallet quote directly. Also: a
"server restart" in a Jest test = closeDbPool + jest.resetModules +
jest.isolateModulesAsync re-import of the route handlers (fresh module state

- fresh pool; all settlement state is in Postgres by design). The full crash
  matrix lives in **tests**/mcp/x402-settlement-restart-staging.test.ts (gated:
  X402_RESTART_TEST_DATABASE_URL + X402_RESTART_TEST_DESTRUCTIVE_OK=1 + mint).
