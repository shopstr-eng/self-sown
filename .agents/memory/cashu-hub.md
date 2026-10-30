---
name: Cashu rules hub
description: index of all Cashu wallet/escrow/mint lessons; open the linked topic file for the full rule, why, and how-to-apply
---

- [Wallet rules](cashu-wallet-rules.md) — mint amount source, post-swap recovery, multi-mint attribution, spent-proof sweep, refresh race, restore verify, send-token ledger.
- [Escrow rules](cashu-escrow-rules.md) — buyer custody, outbox fencing/worker validation, backups excluded from balance, P2PK pubkey normalization, backup-encryption surfacing.
- [API-drift guardrail](cashu-api-contract-guardrail.md) — mocked Send/Mint tests stay green when @cashu/cashu-ts renames methods; guard the contract.
- [v4 live-only requirements](cashu-ts-v4-live-requirements.md) — mocked tests hide v4's live-only requirements: v2 keyset retry, loadMint on all ops, unit-less receive rejection.
- [Test harness](cashu-real-sdk-test-harness.md) — in-test mint signs via SDK helpers; staging preimages + spec vectors fail decoders — self-sign fixtures.
- [Staging mint bootstrap](staging-cashu-mint-bootstrap.md) — workflow self-heals the /tmp venv; firewall blocks h11<0.15; PIP_USER=0; no waitForPort on 127.0.0.1.
