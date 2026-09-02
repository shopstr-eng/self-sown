---
name: Escrow backups are not wallet balance
description: Escrow-locked proofs published to the kind-7375 wallet backup carry an `escrow` marker and must be kept out of every spendable-wallet path; they restore into escrow records, never wallet tokens.
---

# Escrow backups are not wallet balance

Buyers' escrow-locked proofs (P2PK: seller pre-expiry, buyer refund after)
are backed up to the buyer's own kind-7375 wallet events, tagged with an
`escrow` metadata object in the encrypted content, with NO spending-history
event.

**Rule:** every consumer of kind-7375 proof events must branch on the
`escrow` marker. Escrow-marked proofs must NEVER enter the spendable wallet
(token storage, the boot fetch's proof accumulation, spending-history
add-back), and escrow backup events must not be auto-deleted by the
fully-spent-event cleanup. Restore rebuilds the buyer's escrow record with
per-mint UNSPENT verification (fail-closed) and requires the FULL locked set
— the payout validator needs the exact committed amount, so a partial
restore is reported unrecoverable instead.

**Why:** locked proofs in the wallet inflate the balance with funds the
buyer cannot spend before expiry (and the seller can), and spend selection
would try to use them and fail. Deleting spent backups would destroy
recovery material for unresolved escrows.

**How to apply:** the wallet boot fetch ingests kind-7375 from BOTH the
database cache and relays (publish caches to the DB first, so the DB branch
may be the only place a fresh backup appears) — any change to one branch
must be mirrored in the other. Any new kind-7375 consumer must skip
escrow-marked events, and new buyer-escrow-record fields must be mirrored in
the backup metadata or restore can't rebuild the record.
