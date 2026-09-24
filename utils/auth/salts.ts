// KDF salts for the email/OAuth credential blobs (the recovery-key salt lives
// in utils/auth/recovery.ts next to its dual-iteration fallback logic).
//
// The salt is baked into every stored ciphertext, so a rename can never be a
// simple find-and-replace: rows written with the old salt only decrypt with
// the old salt. Writers always use the NEW salt; readers try the new salt
// first and fall back to the legacy one (rotating the row on a legacy hit),
// so existing accounts keep working and migrate lazily with zero data loss.
export const EMAIL_AUTH_SALT = "self-sown-salt";
export const LEGACY_EMAIL_AUTH_SALT = "milk-market-salt";
export const OAUTH_AUTH_SALT = "self-sown-oauth-salt";
export const LEGACY_OAUTH_AUTH_SALT = "milk-market-oauth-salt";
