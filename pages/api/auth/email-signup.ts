
import { NextApiRequest, NextApiResponse } from "next";
import { Client } from "pg";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import CryptoJS from "crypto-js";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  const client = new Client({
    connectionString: process.env["DATABASE_URL"],
  });

  try {
    await client.connect();

    // Create table if it doesn't exist
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

    // Check if email already exists
    const existingUser = await client.query(
      "SELECT id FROM email_auth WHERE email = $1",
      [email]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({ error: "Email already registered" });
    }

    // Generate Nostr key pair
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    const nsec = nip19.nsecEncode(secretKey);

    // Hash password for storage (not used for encryption)
    const passwordHash = CryptoJS.SHA256(email + password).toString();

    // Encrypt nsec with a deterministic key derived from email+password
    // This allows recovery if user forgets their password
    const encryptionKey = CryptoJS.PBKDF2(email + password, "milk-market-salt", {
      keySize: 256/32,
      iterations: 1000
    }).toString();
    
    const encryptedNsec = CryptoJS.AES.encrypt(nsec, encryptionKey).toString();

    // Store in database
    await client.query(
      "INSERT INTO email_auth (email, password_hash, pubkey, encrypted_nsec) VALUES ($1, $2, $3, $4)",
      [email, passwordHash, pubkey, encryptedNsec]
    );

    res.status(201).json({
      success: true,
      nsec,
      pubkey,
    });
  } catch (error) {
    console.error("Email signup error:", error);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    await client.end();
  }
}
