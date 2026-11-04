// Credential storage for user accounts (email + OAuth sign-in).
//
// Threat model: a leaked database must NOT be sufficient to recover a user's
// nsec. nsecs can't be rotated, so a recoverable leak is permanent.
//
// v2 scheme:
//  - Password check (email_auth.password_hash): PBKDF2-SHA256, 600k rounds,
//    per-user random salt, timing-safe verify. Replaces the legacy unsalted
//    single-round SHA-256, which made weak passwords fast to crack offline.
//  - Email nsec: AES-256-GCM under a key derived from
//    PBKDF2(email:password, serverPepper || salt, 600k). The server-held
//    pepper (derived from AUTH_ENCRYPTION_KEY) means a DB-only leak can't
//    even begin offline password cracking; a pepper-only leak still faces
//    the per-user password KDF.
//  - OAuth nsec: AES-256-GCM under a server-held subkey. The legacy scheme
//    derived the key from provider+userId (both stored in the same row) with
//    a repo-constant salt, so DB read access alone decrypted every nsec.
//
// Lazy migration (same pattern as the salt rotation in utils/auth/salts.ts):
// readers try v2 first, fall back to the legacy scheme, and callers re-write
// the row in v2 on a legacy hit (they always hold the password / provider
// identity at that point). Legacy reads need no secret, so existing users
// keep signing in even before AUTH_ENCRYPTION_KEY is configured; new WRITES
// refuse to persist weak rows without it.
//
// Operational note: rotating/losing AUTH_ENCRYPTION_KEY makes v2 rows
// undecryptable (recovery keys are the backstop). Treat rotation as a data
// migration, never a casual env change.

import CryptoJS from "crypto-js";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  pbkdf2Sync,
  randomBytes,
  timingSafeEqual,
} from "crypto";
import {
  EMAIL_AUTH_SALT,
  LEGACY_EMAIL_AUTH_SALT,
  OAUTH_AUTH_SALT,
  LEGACY_OAUTH_AUTH_SALT,
} from "@/utils/auth/salts";

const V2_PREFIX = "v2:";
const V2_PBKDF2_ITERATIONS = 600_000; // matches recovery-key KDF (recovery.ts)
const LEGACY_PBKDF2_ITERATIONS = 1_000;

export function isAuthEncryptionConfigured(): boolean {
  return Boolean(process.env["AUTH_ENCRYPTION_KEY"]);
}

// Purpose-labeled subkeys: the OAuth GCM key and the email KDF pepper are
// independent derivations of the one secret.
function serverSubkey(purpose: string): Buffer | null {
  const secret = process.env["AUTH_ENCRYPTION_KEY"];
  if (!secret) return null;
  return createHash("sha256")
    .update(`self-sown-auth:${purpose}:v2:${secret}`)
    .digest();
}

function requireSubkey(purpose: string, action: string): Buffer {
  const key = serverSubkey(purpose);
  if (!key) {
    throw new Error(
      `AUTH_ENCRYPTION_KEY is not configured; cannot ${action}. Set a random 32+ byte value (e.g. openssl rand -hex 32).`
    );
  }
  return key;
}

function encryptGcm(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${V2_PREFIX}${iv.toString("hex")}:${cipher
    .getAuthTag()
    .toString("hex")}:${ct.toString("hex")}`;
}

function decryptGcm(key: Buffer, blob: string): string {
  const parts = blob.slice(V2_PREFIX.length).split(":");
  if (parts.length !== 3 || parts.some((p) => !p)) {
    throw new Error("Malformed v2 credential blob");
  }
  const [ivHex, tagHex, ctHex] = parts as [string, string, string];
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivHex, "hex")
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

// Legacy CryptoJS AES decrypt across the salt rotation. A wrong key throws or
// yields garbage that fails the nsec1 prefix check — never a valid nsec.
function legacyDecrypt(
  blob: string,
  keyInput: string,
  salts: string[]
): string {
  for (const salt of salts) {
    try {
      const key = CryptoJS.PBKDF2(keyInput, salt, {
        keySize: 256 / 32,
        iterations: LEGACY_PBKDF2_ITERATIONS,
      }).toString();
      const out = CryptoJS.AES.decrypt(blob, key).toString(CryptoJS.enc.Utf8);
      if (out.startsWith("nsec1")) return out;
    } catch {
      // wrong salt — try the next one
    }
  }
  return "";
}

// --- Password hashing (email accounts) ---

export function hashPassword(email: string, password: string): string {
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(
    `${email}:${password}`,
    salt,
    V2_PBKDF2_ITERATIONS,
    32,
    "sha256"
  );
  return `${V2_PREFIX}${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(
  email: string,
  password: string,
  stored: string
): { ok: boolean; needsRehash: boolean } {
  if (stored.startsWith(V2_PREFIX)) {
    const [saltHex, hashHex] = stored.slice(V2_PREFIX.length).split(":");
    if (!saltHex || !hashHex) return { ok: false, needsRehash: false };
    const expected = Buffer.from(hashHex, "hex");
    const actual = pbkdf2Sync(
      `${email}:${password}`,
      Buffer.from(saltHex, "hex"),
      V2_PBKDF2_ITERATIONS,
      expected.length,
      "sha256"
    );
    return {
      ok:
        actual.length === expected.length && timingSafeEqual(actual, expected),
      needsRehash: false,
    };
  }
  // Legacy: unsalted single-round SHA-256 hex of email + password.
  const legacy = CryptoJS.SHA256(email + password).toString();
  const ok =
    legacy.length === stored.length &&
    timingSafeEqual(Buffer.from(legacy), Buffer.from(stored));
  return { ok, needsRehash: ok };
}

// A fixed well-formed v2 hash that never verifies. Signin verifies against
// this when the email doesn't exist so unknown-account and wrong-password
// attempts cost the same KDF time (blunts user-enumeration timing).
let dummyHash: string | null = null;
export function dummyPasswordHash(): string {
  if (!dummyHash) dummyHash = hashPassword("nobody@example.invalid", "dummy");
  return dummyHash;
}

// --- Email account nsec encryption ---

function emailNsecKey(email: string, password: string, pepper: Buffer): Buffer {
  return pbkdf2Sync(
    `${email}:${password}`,
    Buffer.concat([pepper, Buffer.from(EMAIL_AUTH_SALT)]),
    V2_PBKDF2_ITERATIONS,
    32,
    "sha256"
  );
}

export function encryptEmailNsec(
  nsec: string,
  email: string,
  password: string
): string {
  const pepper = requireSubkey("email-pepper", "store account credentials");
  return encryptGcm(emailNsecKey(email, password, pepper), nsec);
}

export function decryptEmailNsec(
  blob: string,
  email: string,
  password: string
): { nsec: string; needsRotation: boolean } {
  if (blob.startsWith(V2_PREFIX)) {
    const pepper = requireSubkey("email-pepper", "decrypt v2 credentials");
    return {
      nsec: decryptGcm(emailNsecKey(email, password, pepper), blob),
      needsRotation: false,
    };
  }
  // Legacy key input was email + password with no separator — keep it exact.
  const nsec = legacyDecrypt(blob, email + password, [
    EMAIL_AUTH_SALT,
    LEGACY_EMAIL_AUTH_SALT,
  ]);
  return { nsec, needsRotation: Boolean(nsec) };
}

// --- OAuth account nsec encryption ---

export function encryptOauthNsec(nsec: string): string {
  const key = requireSubkey("oauth-nsec", "store account credentials");
  return encryptGcm(key, nsec);
}

export function decryptOauthNsec(
  blob: string,
  provider: string,
  providerUserId: string
): { nsec: string; needsRotation: boolean } {
  if (blob.startsWith(V2_PREFIX)) {
    const key = requireSubkey("oauth-nsec", "decrypt v2 credentials");
    return { nsec: decryptGcm(key, blob), needsRotation: false };
  }
  // Legacy key input was `${provider}-${userId}` — keep it exact.
  const nsec = legacyDecrypt(blob, `${provider}-${providerUserId}`, [
    OAUTH_AUTH_SALT,
    LEGACY_OAUTH_AUTH_SALT,
  ]);
  return { nsec, needsRotation: Boolean(nsec) };
}
