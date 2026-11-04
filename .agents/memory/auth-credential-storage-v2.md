---
name: Auth credential storage v2
description: User-account nsec/password storage scheme — server-held AUTH_ENCRYPTION_KEY, lazy migration, fail-closed writes.
---

User-account credentials (email_auth + oauth_auth tables) are stored via `utils/auth/credential-crypto.ts` ("v2"):

- **OAuth nsecs**: AES-256-GCM under a server-held subkey derived from `AUTH_ENCRYPTION_KEY`. The pre-v2 scheme derived the key from provider+userId (stored in the same row) with a repo-constant salt — DB read access alone decrypted every nsec.
- **Email nsecs**: AES-256-GCM under PBKDF2(email:password, pepper‖salt, 600k), pepper derived from `AUTH_ENCRYPTION_KEY`. Pre-v2 was PBKDF2 with 1,000 rounds and no server secret.
- **Email password_hash**: PBKDF2-SHA256, 600k rounds, per-user random salt, timing-safe verify. Pre-v2 was a single unsalted SHA-256 used as a SQL lookup key; v2 requires fetch-by-email then verify in code (signin burns a dummy KDF on unknown emails to blunt enumeration).
- Legacy rows still decrypt without the secret (no lockout) and migrate to v2 on next signin/reset — the same lazy-rotation pattern as the salt rebrand. Writes (signup, new OAuth user, reset-password) REFUSE to persist weak rows when `AUTH_ENCRYPTION_KEY` is unset (loud 500, mirroring the MCP_ENCRYPTION_KEY pattern).

**Why:** a DB-only leak must not recover nsecs — they can't be rotated, so a recoverable leak is permanent. Found 2026-11 via user audit.
**How to apply:** never introduce new CryptoJS/PBKDF2-1000 credential paths — route all reads/writes through credential-crypto.ts. Rotating or losing `AUTH_ENCRYPTION_KEY` strands every v2 row (recovery keys are the backstop), so treat rotation as a data migration. Related: `[Session token revocation](session-token-revocation.md)` for the SESSION_SECRET rotation blast radius.
