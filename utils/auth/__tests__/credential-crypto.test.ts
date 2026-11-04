import CryptoJS from "crypto-js";
import { generateSecretKey, nip19 } from "nostr-tools";
import {
  hashPassword,
  verifyPassword,
  dummyPasswordHash,
  encryptEmailNsec,
  decryptEmailNsec,
  encryptOauthNsec,
  decryptOauthNsec,
  isAuthEncryptionConfigured,
} from "@/utils/auth/credential-crypto";
import {
  EMAIL_AUTH_SALT,
  LEGACY_EMAIL_AUTH_SALT,
  OAUTH_AUTH_SALT,
} from "@/utils/auth/salts";

const TEST_KEY = "test-auth-encryption-key-0123456789abcdef";
const EMAIL = "seller@example.com";
const PASSWORD = "correct horse battery staple";
const NSEC = nip19.nsecEncode(generateSecretKey());

// Craft a blob exactly the way the legacy writers did (CryptoJS AES,
// PBKDF2 1000 rounds, repo salt).
function legacyBlob(keyInput: string, salt: string): string {
  const key = CryptoJS.PBKDF2(keyInput, salt, {
    keySize: 256 / 32,
    iterations: 1000,
  }).toString();
  return CryptoJS.AES.encrypt(NSEC, key).toString();
}

beforeEach(() => {
  process.env["AUTH_ENCRYPTION_KEY"] = TEST_KEY;
});

afterEach(() => {
  delete process.env["AUTH_ENCRYPTION_KEY"];
});

describe("password hashing", () => {
  it("round-trips a v2 hash and rejects the wrong password", () => {
    const stored = hashPassword(EMAIL, PASSWORD);
    expect(stored.startsWith("v2:")).toBe(true);
    expect(verifyPassword(EMAIL, PASSWORD, stored)).toEqual({
      ok: true,
      needsRehash: false,
    });
    expect(verifyPassword(EMAIL, "wrong", stored).ok).toBe(false);
    // Per-user random salt: two hashes of the same password differ.
    expect(hashPassword(EMAIL, PASSWORD)).not.toBe(stored);
  });

  it("verifies a legacy SHA-256 hash and flags it for rehash", () => {
    const legacy = CryptoJS.SHA256(EMAIL + PASSWORD).toString();
    expect(verifyPassword(EMAIL, PASSWORD, legacy)).toEqual({
      ok: true,
      needsRehash: true,
    });
    expect(verifyPassword(EMAIL, "wrong", legacy).ok).toBe(false);
  });

  it("dummy hash never verifies (used for timing equalization)", () => {
    expect(verifyPassword(EMAIL, PASSWORD, dummyPasswordHash()).ok).toBe(
      false
    );
  });
});

describe("email nsec encryption", () => {
  it("round-trips through the v2 envelope", () => {
    const blob = encryptEmailNsec(NSEC, EMAIL, PASSWORD);
    expect(blob.startsWith("v2:")).toBe(true);
    const out = decryptEmailNsec(blob, EMAIL, PASSWORD);
    expect(out).toEqual({ nsec: NSEC, needsRotation: false });
  });

  it("v2 decryption fails with the wrong password or a tampered blob", () => {
    const blob = encryptEmailNsec(NSEC, EMAIL, PASSWORD);
    expect(() => decryptEmailNsec(blob, EMAIL, "wrong")).toThrow();
    const tampered = blob.slice(0, -2) + (blob.endsWith("aa") ? "bb" : "aa");
    expect(() => decryptEmailNsec(tampered, EMAIL, PASSWORD)).toThrow();
  });

  it("decrypts legacy blobs under either salt and flags rotation", () => {
    for (const salt of [EMAIL_AUTH_SALT, LEGACY_EMAIL_AUTH_SALT]) {
      const blob = legacyBlob(EMAIL + PASSWORD, salt);
      const out = decryptEmailNsec(blob, EMAIL, PASSWORD);
      expect(out).toEqual({ nsec: NSEC, needsRotation: true });
    }
    // Wrong password never yields a valid nsec.
    expect(
      decryptEmailNsec(legacyBlob(EMAIL + PASSWORD, EMAIL_AUTH_SALT), EMAIL, "wrong")
        .nsec
    ).toBe("");
  });

  it("a v2 blob is NOT decryptable via the legacy scheme (server pepper bound)", () => {
    const blob = encryptEmailNsec(NSEC, EMAIL, PASSWORD);
    // Anyone holding only the DB row + repo salts gets nothing: the v2 hex
    // format isn't even a parseable CryptoJS blob, so the legacy decrypt
    // throws outright.
    expect(blob.startsWith("U2FsdGVkX1")).toBe(false);
    expect(() =>
      CryptoJS.AES.decrypt(
        blob,
        CryptoJS.PBKDF2(EMAIL + PASSWORD, EMAIL_AUTH_SALT, {
          keySize: 256 / 32,
          iterations: 1000,
        }).toString()
      ).toString(CryptoJS.enc.Utf8)
    ).toThrow();
  });
});

describe("oauth nsec encryption", () => {
  it("round-trips through the v2 server-key scheme", () => {
    const blob = encryptOauthNsec(NSEC);
    const out = decryptOauthNsec(blob, "google", "g-123");
    expect(out).toEqual({ nsec: NSEC, needsRotation: false });
  });

  it("decrypts legacy provider-derived blobs and flags rotation", () => {
    const blob = legacyBlob("google-g-123", OAUTH_AUTH_SALT);
    const out = decryptOauthNsec(blob, "google", "g-123");
    expect(out).toEqual({ nsec: NSEC, needsRotation: true });
  });

  it("a v2 blob does not decrypt with the legacy provider-derived key", () => {
    const blob = encryptOauthNsec(NSEC);
    // The v2 hex format isn't a parseable CryptoJS blob — the legacy
    // provider-derived key attempt throws rather than yielding the nsec.
    expect(() =>
      CryptoJS.AES.decrypt(
        blob,
        CryptoJS.PBKDF2("google-g-123", OAUTH_AUTH_SALT, {
          keySize: 256 / 32,
          iterations: 1000,
        }).toString()
      ).toString(CryptoJS.enc.Utf8)
    ).toThrow();
  });
});

describe("missing server secret", () => {
  beforeEach(() => {
    delete process.env["AUTH_ENCRYPTION_KEY"];
  });

  it("reports unconfigured and refuses to WRITE new credentials", () => {
    expect(isAuthEncryptionConfigured()).toBe(false);
    expect(() => encryptOauthNsec(NSEC)).toThrow(/AUTH_ENCRYPTION_KEY/);
    expect(() => encryptEmailNsec(NSEC, EMAIL, PASSWORD)).toThrow(
      /AUTH_ENCRYPTION_KEY/
    );
  });

  it("still reads legacy rows without the secret (no lockout)", () => {
    const blob = legacyBlob("apple-a-1", OAUTH_AUTH_SALT);
    expect(decryptOauthNsec(blob, "apple", "a-1").nsec).toBe(NSEC);
    const legacy = CryptoJS.SHA256(EMAIL + PASSWORD).toString();
    expect(verifyPassword(EMAIL, PASSWORD, legacy).ok).toBe(true);
  });

  it("fails loudly when a v2 row is read without the secret", () => {
    process.env["AUTH_ENCRYPTION_KEY"] = TEST_KEY;
    const blob = encryptOauthNsec(NSEC);
    delete process.env["AUTH_ENCRYPTION_KEY"];
    expect(() => decryptOauthNsec(blob, "google", "g-123")).toThrow(
      /AUTH_ENCRYPTION_KEY/
    );
  });
});
