---
name: Escrow backup encryption failure surfacing
description: publishEscrowBackup returns typed failures; encryption_failed is permanent for nip04-only bunkers and must reach the buyer, never console-only
---

NIP-46 signers in this app CAN encrypt to self (nip44_encrypt RPC, requested in the base permitted-methods list at connect), but the capability is bunker-dependent: nip04-only bunkers or denied permissions reject the RPC. NIP-07 is guarded at construction (requires window.nostr.nip44); nsec has built-in nip44.

**Rule:** an escrow backup publish failure must always reach a buyer-visible surface. `publishEscrowBackup` returns `{ published, failure? }` with failure ∈ unavailable / encryption_failed / publish_failed; `republishMissingEscrowBackups` reports `unbacked` records with reasons. Checkout cards and both wallet pages render `describeEscrowBackupWarning(failure)` — never swallow to console.warn alone.

**Why:** a silently-missing kind-7375 escrow backup is a recovery path that doesn't exist; a buyer who loses their browser strands the locked proofs. encryption_failed is permanent for that signer, so retrying every wallet visit re-prompts the bunker futilely (known residual: no session give-up yet).

**How to apply:** any new caller of publish/republish must handle the typed result and surface the warning; new failure modes get a new EscrowBackupFailure variant, not a bare false.
