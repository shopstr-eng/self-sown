---
name: Profile local-fallback ordering
description: Why any code that writes the kind:0 profile localStorage fallback must publish the event first.
---

# Kind:0 profile local-fallback must be written only after a confirmed publish

The user-profile settings form (`pages/settings/user-profile.tsx`) resets its
form from whichever is newer: the cached kind:0 profile event, or a localStorage
"fallback" keyed by `getLocalUserProfileKey(pubkey)` (it prefers the fallback
when `fallback.updatedAt > profile.created_at`).

**Rule:** Any code that auto-edits the profile (e.g. the custom-domain section
auto-setting NIP-05 to `<name>@<domain>` once a domain verifies) must call
`createNostrProfileEvent(...)` FIRST and only write the localStorage fallback +
`updateProfileData(...)` after the publish resolves.

**Why:** writing the fallback before publishing means a rejected signer prompt
or relay/signer error leaves a newer fallback on disk, so the settings form
shows a NIP-05 (or other field) that was never actually published — silent state
drift and a false-success UX.

**How to apply:** publish → on success, persist fallback + update
`ProfileMapContext`; on failure, persist nothing and clear any
"already-synced" guard so a later retry can re-attempt.
