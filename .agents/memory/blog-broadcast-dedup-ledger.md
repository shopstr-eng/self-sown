---
name: Blog broadcast dedup is an immutable per-recipient ledger
description: Broadcast dedup must key on immutable delivered-recipient records, never on current audience-segment membership.
---

Blog post broadcasts can send the same post version once per audience segment, but a contact must never receive the same version twice. Dedup is an immutable per-recipient delivery ledger (one row per version+email), NOT current segment membership.

**Why:** A capture's segment source is mutable (subscription → popup when the contact later claims a welcome offer), so reconstructing "who was emailed" from current membership re-emails them after a flip. The per-recipient row is also claimed atomically before the provider call, which is what makes concurrent cross-segment sends safe.

**How to apply:** Any new broadcast audience/segment must subtract the delivered-recipient ledger and claim each recipient before sending. A send that ends up owning zero recipients (a concurrent send claimed them all) must release its version-level claim or it permanently burns that version for late-joining contacts. Failed sends release their own recipient claim; a claim whose DB outcome is unknown is never released — at-most-once is the safe failure mode for a blast.
