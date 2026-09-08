import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export function createNotificationTokenVault(encodedKey: string) {
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32 || key.toString("base64") !== encodedKey) {
    throw new Error("Notification encryption key is not configured");
  }
  return {
    encrypt(value: string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final(),
      ]);
      return [
        "v1",
        iv.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        encrypted.toString("base64url"),
      ].join(".");
    },
    decrypt(value: string): string {
      try {
        const [version, iv, tag, ciphertext, extra] = value.split(".");
        if (
          version !== "v1" ||
          !iv ||
          !tag ||
          !ciphertext ||
          extra !== undefined
        )
          throw new Error();
        const nonce = Buffer.from(iv, "base64url");
        const authTag = Buffer.from(tag, "base64url");
        if (nonce.length !== 12 || authTag.length !== 16) throw new Error();
        const decipher = createDecipheriv("aes-256-gcm", key, nonce);
        decipher.setAuthTag(authTag);
        return Buffer.concat([
          decipher.update(Buffer.from(ciphertext, "base64url")),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        throw new Error("Invalid encrypted notification token");
      }
    },
  };
}
