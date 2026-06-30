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

**Why not fixed at the provider:** a provider/signer-level challenge mutex/queue
would fix this app-wide but has broad blast radius across all signing; left as a
longer-term option. Per-page serialization is the targeted fix.
