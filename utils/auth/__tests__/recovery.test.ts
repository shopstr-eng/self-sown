import CryptoJS from "crypto-js";
import {
  encryptNsecWithRecoveryKey,
  decryptNsecWithRecoveryKey,
} from "@/utils/auth/recovery";

// Regression coverage for the salt rotation (milk-market-recovery →
// self-sown-recovery): blobs written before the rebrand must still decrypt,
// and a wrong key / malformed blob must throw "Invalid recovery key" — never
// leak garbage that reset-password would persist under the new salts.

const KEY_A = "ABCD-EFGH-JKMN-PQRS-TUVW-2345"; // recovery-key charset only
const KEY_B = "WXYZ-2345-6789-ABCD-EFGH-JKMN";
const NSEC = "nsec1" + "a".repeat(58);

const NEW_SALT = "self-sown-recovery";
const LEGACY_SALT = "milk-market-recovery";

function encryptWith(
  plaintext: string,
  recoveryKey: string,
  salt: string,
  iterations: number
): string {
  const normalized = recoveryKey.replace(/-/g, "").toUpperCase();
  const key = CryptoJS.PBKDF2(normalized, salt, {
    keySize: 256 / 32,
    iterations,
  }).toString();
  return CryptoJS.AES.encrypt(plaintext, key).toString();
}

describe("decryptNsecWithRecoveryKey salt migration", () => {
  it("round-trips a blob written with the current salt", () => {
    const blob = encryptNsecWithRecoveryKey(NSEC, KEY_A);
    expect(decryptNsecWithRecoveryKey(blob, KEY_A)).toBe(NSEC);
  });

  it("decrypts a pre-rebrand blob (legacy salt, 600k iterations)", () => {
    const blob = encryptWith(NSEC, KEY_A, LEGACY_SALT, 600000);
    expect(decryptNsecWithRecoveryKey(blob, KEY_A)).toBe(NSEC);
  });

  it("decrypts a pre-rebrand blob (legacy salt, legacy 1000 iterations)", () => {
    const blob = encryptWith(NSEC, KEY_A, LEGACY_SALT, 1000);
    expect(decryptNsecWithRecoveryKey(blob, KEY_A)).toBe(NSEC);
  });

  it("encrypts only with the new salt (new-salt-only probe succeeds first)", () => {
    const blob = encryptNsecWithRecoveryKey(NSEC, KEY_A);
    // A blob written by the new code must NOT decrypt under the legacy salt.
    expect(() =>
      decryptNsecWithRecoveryKey(
        encryptWith(NSEC, KEY_A, NEW_SALT, 1000),
        KEY_A
      )
    ).toThrow("Invalid recovery key");
    expect(decryptNsecWithRecoveryKey(blob, KEY_A)).toBe(NSEC);
  });

  it("throws Invalid recovery key for malformed ciphertext (never a UTF-8 error)", () => {
    expect(() =>
      decryptNsecWithRecoveryKey("!!!not-a-ciphertext!!!", KEY_A)
    ).toThrow("Invalid recovery key");
    expect(() => decryptNsecWithRecoveryKey("", KEY_A)).toThrow(
      "Invalid recovery key"
    );
  });

  it("throws Invalid recovery key for the wrong key (never returns garbage)", () => {
    const blob = encryptNsecWithRecoveryKey(NSEC, KEY_A);
    expect(() => decryptNsecWithRecoveryKey(blob, KEY_B)).toThrow(
      "Invalid recovery key"
    );
  });

  it("rejects a correct-key blob whose plaintext is not an nsec", () => {
    // Guards the garbage-persistence path: only nsec1-prefixed plaintexts
    // count as a successful decrypt.
    const blob = encryptWith("not-an-nsec", KEY_A, NEW_SALT, 600000);
    expect(() => decryptNsecWithRecoveryKey(blob, KEY_A)).toThrow(
      "Invalid recovery key"
    );
  });
});
