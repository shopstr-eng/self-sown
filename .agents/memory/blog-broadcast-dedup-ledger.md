---
name: Blog broadcast dedup is an immutable per-recipient ledger
description: Broadcast dedup must key on immutable delivered-recipient records, never on current audience-segment membership.
---

Blog post broadcasts can send the same post version once per audience segment, but a contact must never receive the same version twice. Dedup is an immutable per-recipient delivery ledger (one row per version+email), NOT current segment membership.

**Why:** A capture's segment source is mutable (subscription → popup when the contact later claims a welcome offer), so reconstructing "who was emailed" from current membership re-emails them after a flip. The per-recipient row is also claimed atomically before the provider call, which is what makes concurrent cross-segment sends safe.

**How to apply:** Any new broadcast audience/segment must subtract the delivered-recipient ledger and claim each recipient before sending. A send that ends up owning zero recipients (a concurrent send claimed them all) must release its version-level claim or it permanently burns that version for late-joining contacts. Failed sends release their own recipient claim; a claim whose DB outcome is unknown is never released — at-most-once is the safe failure mode for a blast.

Dead-address suppression: a provider rejection is durably suppressed (into the per-seller email_unsubscribes list, which the audience SQL filters out of every future send) ONLY when the rejection blames the recipient address itself (the `recipientReject` flag). Never suppress on a blanket definiteReject: account/sender-level 4xx (401/403, e.g. a lapsed domain authentication) fails EVERY recipient identically, so suppressing on those would wipe a seller's entire audience in one blast. The same applies WITHIN 400s: only an explicit recipient `to` field path or a suppression-list message naming the to/recipient address counts — "personalizations.*" also matches subject/headers, and SendGrid uses "invalid email" wording for the FROM address too, so those must never classify as recipient faults.

**Why:** email_unsubscribes doubles as the auto-suppression list, so any future seller-facing "unsubscribed" UI or resubscribe flow will see auto-suppressed dead addresses too; distinguish by cause if that ever matters.

**How to apply (suppression):** when extending the classifier, prefer false negatives (a dead address retried once more) over ANY false positive (a healthy address permanently dropped); every new match pattern needs a paired negative test with sender/content-level wording.
