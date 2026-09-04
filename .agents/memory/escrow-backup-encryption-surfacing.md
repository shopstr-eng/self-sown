---
name: Escrow backup encryption failure surfacing
description: publishEscrowBackup returns typed failures; encryption_failed is permanent for nip04-only bunkers and must reach the buyer, never console-only
---

NIP-46 signers in this app CAN encrypt to self (nip44_encrypt RPC, requested in the base permitted-methods list at connect), but the capability is bunker-dependent: nip04-only bunkers or denied permissions reject the RPC. NIP-07 is guarded at construction (requires window.nostr.nip44); nsec has built-in nip44.

**Rule:** an escrow backup publish failure must always reach a buyer-visible surface. `publishEscrowBackup` returns `{ published, failure? }` with failure ∈ unavailable / encryption_failed / publish_failed; `republishMissingEscrowBackups` reports `unbacked` records with reasons. Checkout cards and both wallet pages render `describeEscrowBackupWarning(failure)` — never swallow to console.warn alone.

**Why:** a silently-missing kind-7375 escrow backup is a recovery path that doesn't exist; a buyer who loses their browser strands the locked proofs. encryption_failed is permanent for that signer, so republishMissingEscrowBackups session-caches give-ups — but ONLY for demonstrated capability/permission rejections (isPermanentEncryptionFailure message match; transport errors classify publish_failed and keep retrying). All session state (give-up + in-flight) is per-signer WeakMap<object, Set>: same-pubkey signer swaps must publish immediately, and a late failure must bind to the signer that produced it. Records are also filtered to the signer's own pubkey — the local store is shared across accounts in a browser profile, so an account switch must never encrypt/publish the previous account's locked proofs.

**How to apply:** any new caller of publish/republish must handle the typed result and surface the warning; new failure modes get a new EscrowBackupFailure variant, not a bare false.

**Render-surface rule:** the warning must render in a view the ACTIVE payment path actually shows. Both checkout cards have an invoice view gated on `showInvoiceCard` that only the Lightning handlers open — a banner rendered only there was invisible to direct Cashu escrow payments (state set, never displayed). The banner now also renders in the main payment view of both cards.

**Why:** setting state is not surfacing; check which views each payment path (Lightning vs direct Cashu vs fiat) opens before placing a warning.
