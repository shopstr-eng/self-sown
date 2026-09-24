import CryptoJS from "crypto-js";
import { randomBytes } from "crypto";

const RECOVERY_KEY_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const RECOVERY_TOKEN_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
const RECOVERY_PBKDF2_ITERATIONS = 600000;
const LEGACY_PBKDF2_ITERATIONS = 1000;

function secureRandomIndex(max: number): number {
  const bytes = randomBytes(4);
  const value = bytes.readUInt32BE(0);
  return value % max;
}

export function generateRecoveryKey(): string {
  const segments: string[] = [];
  for (let s = 0; s < 6; s++) {
    let segment = "";
    for (let i = 0; i < 4; i++) {
      segment +=
        RECOVERY_KEY_CHARS[secureRandomIndex(RECOVERY_KEY_CHARS.length)];
    }
    segments.push(segment);
  }
  return segments.join("-");
}

export function hashRecoveryKey(recoveryKey: string): string {
  const normalized = recoveryKey.replace(/-/g, "").toUpperCase();
  return CryptoJS.SHA256(normalized).toString();
}

// The KDF salt rotated in the Self-sown rebrand. Encryption always uses the
// new salt; decryption tries the new salt first, then the legacy salt (under
// both KDF iteration counts), so blobs written before the rebrand still
// decrypt. Rows rotate to the new salt the next time they're re-encrypted
// (signup / setup-recovery / reset-password all re-encrypt on write).
const RECOVERY_SALT = "self-sown-recovery";
const LEGACY_RECOVERY_SALT = "milk-market-recovery";

export function encryptNsecWithRecoveryKey(
  nsec: string,
  recoveryKey: string
): string {
  const normalized = recoveryKey.replace(/-/g, "").toUpperCase();
  const encryptionKey = CryptoJS.PBKDF2(normalized, RECOVERY_SALT, {
    keySize: 256 / 32,
    iterations: RECOVERY_PBKDF2_ITERATIONS,
  }).toString();
  return CryptoJS.AES.encrypt(nsec, encryptionKey).toString();
}

export function decryptNsecWithRecoveryKey(
  encryptedNsec: string,
  recoveryKey: string
): string {
  const normalized = recoveryKey.replace(/-/g, "").toUpperCase();

  // Probe each salt/iteration combination. A wrong-key AES decrypt can THROW
  // ("Malformed UTF-8 data") or yield nonempty garbage, so each attempt is
  // isolated and only a value with the bech32 nsec prefix counts — anything
  // less would let reset-password persist garbage under the new salts and
  // corrupt account recovery.
  const combos: Array<[string, number]> = [
    [RECOVERY_SALT, RECOVERY_PBKDF2_ITERATIONS],
    [LEGACY_RECOVERY_SALT, RECOVERY_PBKDF2_ITERATIONS],
    [LEGACY_RECOVERY_SALT, LEGACY_PBKDF2_ITERATIONS],
  ];
  for (const [salt, iterations] of combos) {
    try {
      const key = CryptoJS.PBKDF2(normalized, salt, {
        keySize: 256 / 32,
        iterations,
      }).toString();
      const attempt = CryptoJS.AES.decrypt(encryptedNsec, key).toString(
        CryptoJS.enc.Utf8
      );
      if (attempt.startsWith("nsec1")) return attempt;
    } catch {
      // wrong key for this combination — try the next one
    }
  }

  throw new Error("Invalid recovery key");
}

export function generateRecoveryToken(): string {
  let token = "";
  for (let i = 0; i < 64; i++) {
    token +=
      RECOVERY_TOKEN_CHARS[secureRandomIndex(RECOVERY_TOKEN_CHARS.length)];
  }
  return token;
}

export function generateVerificationCode(): string {
  const bytes = randomBytes(4);
  const num = bytes.readUInt32BE(0) % 1000000;
  return num.toString().padStart(6, "0");
}
