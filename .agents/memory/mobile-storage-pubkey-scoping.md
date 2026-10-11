---
name: Mobile device-local data must be pubkey-scoped
description: Any AsyncStorage-persisted user data in apps/mobile (settings, addresses, preferences) must be keyed by seller pubkey; app-wide keys leak one account's data to the next signed-in account on a shared device.
---

# Mobile device-local data must be pubkey-scoped

In `apps/mobile`, any AsyncStorage key holding per-account user data — saved
shipping addresses, mints, relay lists, Blossom servers, profile fallbacks —
must include the seller pubkey (e.g. `self-sown:saved-addresses:<pubkey>`),
even when the web equivalent uses a single app-wide localStorage key.

**Why:** Signing out only removes the session from SecureStore; a second
account signing in on the same device would otherwise read (and could even
publish) the previous account's data — saved shipping addresses include names
and street addresses, so app-wide keys are a cross-account PII leak.

**How to apply:** Thread `session.pubkey` into every storage accessor the
moment the lib is created; screens already hold the session. Never migrate
legacy unscoped data to the next signed-in account (owner is unknowable) —
delete the unscoped key on first access instead. Add an account-switch test
(data written under pubkey A invisible under pubkey B) for each new store.
Related: credential-storage-logout-sweep for actual credential keys.
