/** @jest-environment node */
import { createNotificationTokenVault } from "../token-crypto";

describe("push token vault", () => {
  const key = Buffer.alloc(32, 17).toString("base64");
  test("encrypts with a fresh nonce and authenticates the ciphertext", () => {
    const vault = createNotificationTokenVault(key);
    const first = vault.encrypt("ExpoPushToken[private]");
    const second = vault.encrypt("ExpoPushToken[private]");
    expect(first).not.toBe(second);
    expect(first).not.toContain("private");
    expect(vault.decrypt(first)).toBe("ExpoPushToken[private]");
    expect(() => vault.decrypt(first.slice(0, -5) + "aaaaa")).toThrow(
      "Invalid encrypted notification token"
    );
  });
  test("rejects a wrong encryption key without leaking the ciphertext", () => {
    const ciphertext = createNotificationTokenVault(key).encrypt("private");
    expect(() =>
      createNotificationTokenVault(
        Buffer.alloc(32, 18).toString("base64")
      ).decrypt(ciphertext)
    ).toThrow("Invalid encrypted notification token");
  });
  test.each(["", "bad", Buffer.alloc(16).toString("base64")])(
    "rejects an invalid key %s",
    (key) => {
      expect(() => createNotificationTokenVault(key)).toThrow(
        "Notification encryption key is not configured"
      );
    }
  );
});
