---
name: OAuth local key unlock lifecycle
description: Separate OAuth identity proof from a user-chosen local encryption secret, including migration and session-memory behavior.
---

OAuth identity is not a local encryption passphrase. Never derive the unlock secret from a provider name, email, or other public identity field. Use a user-chosen passphrase and a one-use encrypted server handoff; never carry the private key in a redirect URL. Migrating an old OAuth-encrypted key must leave its old ciphertext intact until the newly encrypted key is saved and validated. For OAuth-created accounts, an optional “keep unlocked” choice is memory-only, not sessionStorage; a page reload requires a prompt.

**Why:** email-derived secrets made stolen local ciphertext decryptable; URL-carried keys leak into browser history and infrastructure logs; sessionStorage-restored passphrases undermine an otherwise memory-only OAuth migration.

**How to apply:** preserve the local-key migration fallback until existing accounts have safely re-encrypted, but never auto-unlock legacy accounts from their public provider/email identity. Check both sign-in and reload behavior whenever the signer serialization shape changes.
