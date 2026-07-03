---
name: Single-flight passphrase challenge / concurrent signing
description: Why pages that fire multiple signer.sign on mount hang on a stuck spinner, and how to fix it.
---

# Concurrent signing deadlocks the single-flight passphrase challenge

`SignerContextProvider` (`components/utility-components/nostr-context-provider.tsx`)
stores exactly ONE `challengeResolver` in state. The passphrase modal's
`actionOnSubmit` resolves whatever `challengeResolver` currently is.

`NostrNSecSigner._getPrivKey()` (`utils/nostr/signers/nostr-nsec-signer.ts`)
opens the challenge only when no passphrase is cached. After one successful
decrypt it caches the key (`inputPassphrase` for ~5s, `rememberedPassphrase` if
"remember", and `this.pubkey`), so subsequent signs in that window don't prompt.

**The trap:** if a component fires TWO+ `signer.sign()/encrypt()/decrypt()`
calls concurrently _while the key is not yet cached_, each opens a challenge and
the second `setChallengeResolver` overwrites the first. Submitting the modal
resolves only the second; the first `await signer.sign(...)` hangs forever, so
its `finally { setLoading(false) }` never runs → permanent stuck spinner.
Navigating away and back "fixes" it because by then the key is cached, so no
challenge fires. The provider's own comments document this clobbering.

**How to apply:** any page/dashboard that makes more than one signed call on
mount (or reactively right after) must run them in ONE deterministic sequential
chain (`await a(); await b();`), not separate concurrent effects. Thread any
data that decides whether a later signed call runs through the earlier call's
return value, not through a separate `useEffect` watching state it set — a
state-watching effect re-introduces the concurrency. Reuse one shared
"refresh sequence" helper for every caller (mount, modal-close, etc.) so no
direct single-call refresh sneaks back in.

**Real case:** `pages/settings/payments.tsx` fired `loadStatus` (Stripe),
`loadSquareStatus`, and a status-watching tax effect — three concurrent signs on
first load → hang. Fixed by one mount sequence: Stripe (+ tax if chargesEnabled)
→ Square, with `loadStatus` returning its `AccountStatus`.

**Source-level fix now in place:** `NostrNSecSigner._getPrivKey()` is now
single-flight — it coalesces concurrent callers onto ONE in-flight
`_getPrivKeyUncached()` promise (stored in `privKeyInFlight`, cleared in
`.finally` on both resolve and reject). So concurrent `sign/encrypt/decrypt`
during the not-yet-cached window now share ONE challenge instead of clobbering
the resolver. This is what makes batched gift-wrap decryption (the Orders
dashboard) safe. **Why still serialize per-page too:** the single-flight only
coalesces calls that overlap the SAME in-flight unlock; sequential waves after
the first resolve rely on the ~5s `inputPassphrase` cache, and if the user
CANCELS the prompt nothing is cached, so a fresh wave re-prompts. Deterministic
per-page sequencing (above) is still the belt-and-suspenders fix for mount-time
signing. Do NOT remove the single-flight guard — it is the app-wide backstop.
