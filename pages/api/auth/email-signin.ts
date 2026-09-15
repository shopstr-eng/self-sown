import { NextApiRequest, NextApiResponse } from "next";
import { Client } from "pg";
import CryptoJS from "crypto-js";
import { applyRateLimit } from "@/utils/rate-limit";
import { EMAIL_AUTH_SALT, LEGACY_EMAIL_AUTH_SALT } from "@/utils/auth/salts";
import { withSchemaDdlLock } from "@/utils/db/db-service";

const RATE_LIMIT = { limit: 10, windowMs: 60 * 1000 };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await applyRateLimit(req, res, "auth-email-signin", RATE_LIMIT)))
    return;

  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  const client = new Client({
    connectionString: process.env["DATABASE_URL"],
  });

  try {
    await client.connect();

    await withSchemaDdlLock(client, async () => {
      await client.query(`
      CREATE TABLE IF NOT EXISTS email_auth (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        pubkey VARCHAR(64) NOT NULL,
        encrypted_nsec TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    });

    const passwordHash = CryptoJS.SHA256(email + password).toString();

    // Get user from database
    const result = await client.query(
      "SELECT pubkey, encrypted_nsec FROM email_auth WHERE email = $1 AND password_hash = $2",
      [email, passwordHash]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const { pubkey, encrypted_nsec } = result.rows[0];

    // Decrypt nsec. The KDF salt rotated in the Self-sown rebrand: try the
    // new salt first, fall back to the legacy salt, and on a legacy hit
    // lazily re-encrypt the row under the new salt (zero-downtime migration,
    // no data loss). A wrong-salt decrypt yields garbage that fails Utf8
    // decoding or the nsec1 prefix check — never a valid nsec.
    const deriveKey = (salt: string) =>
      CryptoJS.PBKDF2(email + password, salt, {
        keySize: 256 / 32,
        iterations: 1000,
      }).toString();
    const tryDecrypt = (salt: string): string => {
      try {
        const out = CryptoJS.AES.decrypt(
          encrypted_nsec,
          deriveKey(salt)
        ).toString(CryptoJS.enc.Utf8);
        return out.startsWith("nsec1") ? out : "";
      } catch {
        return "";
      }
    };

    let decryptedNsec = tryDecrypt(EMAIL_AUTH_SALT);
    if (!decryptedNsec) {
      decryptedNsec = tryDecrypt(LEGACY_EMAIL_AUTH_SALT);
      if (decryptedNsec) {
        // Legacy-salt row: re-encrypt under the new salt (best-effort — a
        // failed rotation just means the fallback runs again next signin).
        try {
          const rotated = CryptoJS.AES.encrypt(
            decryptedNsec,
            deriveKey(EMAIL_AUTH_SALT)
          ).toString();
          await client.query(
            "UPDATE email_auth SET encrypted_nsec = $1 WHERE email = $2",
            [rotated, email]
          );
        } catch (rotateErr) {
          console.error("email-signin: salt rotation failed:", rotateErr);
        }
      }
    }

    res.status(200).json({
      success: true,
      nsec: decryptedNsec,
      pubkey,
    });
  } catch (error) {
    console.error("Email signin error:", error);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    await client.end();
  }
}
