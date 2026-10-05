# Authentication & Recovery

## Signers

NIP-07, NIP-46, direct nsec (with ncryptsec auto-detection). NIP-49 encrypted storage with auto-migration.

## OAuth Sign-In (Apple & Google)

Social sign-in alongside Nostr signers. `pages/api/auth/oauth-redirect.ts` starts the flow (`provider` = `google` | `apple`); `pages/api/auth/oauth-callback.ts` completes it. The `redirect_uri` is pinned to this origin's `/api/auth/oauth-callback` (https only; http allowed for localhost) because it round-trips through a cookie and the provider. Apple auth uses an ES256 client-secret JWT built from `APPLE_TEAM_ID`/`APPLE_KEY_ID`/`APPLE_PRIVATE_KEY` (+ `APPLE_CLIENT_ID`); Google uses `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`.

## Account Recovery

For email + nsec-with-email users: 24-char segmented recovery key generated at signup or in profile settings, downloadable as `.txt`.

Flow: email-verification token → recovery key + new password → re-encrypted nsec.

- Tables: `account_recovery`, `account_recovery_tokens`, `recovery_email_verifications`.
- APIs under `pages/api/auth/`; UI: `RecoveryKeyModal`, `/auth/recover`, "Forgot password?" in `SignInModal`. Helpers in `utils/auth/recovery.ts`.
- Security: `crypto.randomBytes` RNG; PBKDF2 600k iterations (back-compat with 1k); per-route rate limiting; email verification required.
