// KDF salts for the email/OAuth credential blobs (the recovery-key salt lives
// in utils/auth/recovery.ts next to its dual-iteration fallback logic).
//
// LEGACY READS ONLY. New writes use the v2 scheme in
// utils/auth/credential-crypto.ts (AES-256-GCM under a server-held key/pepper)
// and never touch these salts. They remain so rows written before v2 — and
// before the Self-sown rebrand salt rotation — still decrypt: readers try v2
// first, then the new salt, then the legacy one, and callers rotate the row
// to v2 on a legacy hit, so existing accounts migrate lazily with zero data
// loss. A rename can never be a find-and-replace: unmigrated rows written
// with an old salt only decrypt with that salt.
export const EMAIL_AUTH_SALT = "self-sown-salt";
export const LEGACY_EMAIL_AUTH_SALT = "milk-market-salt";
export const OAUTH_AUTH_SALT = "self-sown-oauth-salt";
export const LEGACY_OAUTH_AUTH_SALT = "milk-market-oauth-salt";
