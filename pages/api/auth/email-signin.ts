import { NextApiRequest, NextApiResponse } from "next";
import { Client } from "pg";
import { applyRateLimit } from "@/utils/rate-limit";
import {
  verifyPassword,
  dummyPasswordHash,
  decryptEmailNsec,
  hashPassword,
  encryptEmailNsec,
} from "@/utils/auth/credential-crypto";
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

    // Look up by email, then verify in code: v2 password hashes carry a
    // per-user random salt, so the hash can't be a SQL lookup key the way
    // the legacy unsalted SHA-256 was.
    const result = await client.query(
      "SELECT pubkey, encrypted_nsec, password_hash FROM email_auth WHERE email = $1",
      [email]
    );

    if (result.rows.length === 0) {
      // Burn the same KDF time as a real verify to blunt user enumeration.
      verifyPassword(email, password, dummyPasswordHash());
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const { pubkey, encrypted_nsec, password_hash } = result.rows[0];
    const check = verifyPassword(email, password, password_hash);
    if (!check.ok) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const { nsec: decryptedNsec, needsRotation } = decryptEmailNsec(
      encrypted_nsec,
      email,
      password
    );
    if (!decryptedNsec) {
      // The password verified but the blob didn't decrypt — the row is
      // corrupt (a wrong password failed above). Loud, not silent.
      console.error("email-signin: password verified but nsec decrypt failed");
      return res.status(500).json({ error: "Internal server error" });
    }

    // Lazy migration to the v2 scheme: legacy hash and/or legacy nsec blob
    // are re-written now (we hold the plaintext password only at signin).
    // Best-effort — a failed rotation just runs again next signin.
    if (check.needsRehash || needsRotation) {
      try {
        await client.query(
          "UPDATE email_auth SET password_hash = $1, encrypted_nsec = $2 WHERE email = $3",
          [
            hashPassword(email, password),
            encryptEmailNsec(decryptedNsec, email, password),
            email,
          ]
        );
      } catch (rotateErr) {
        console.error("email-signin: credential migration failed:", rotateErr);
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
