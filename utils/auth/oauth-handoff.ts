import { createHash, randomBytes } from "crypto";
import { getDbPool, withSchemaDdlLock } from "@/utils/db/db-service";
import { decryptOauthNsec, encryptOauthNsec } from "./credential-crypto";

export const OAUTH_HANDOFF_COOKIE = "__Host-ss-oauth-handoff";
export const OAUTH_HANDOFF_TTL_SECONDS = 120;

export interface OAuthHandoff {
  nsec: string;
  pubkey: string;
  provider: "apple" | "google";
  email?: string;
  isNewUser: boolean;
  flow?: "seller";
}

let ready = false;
async function ensureTable() {
  if (ready) return;
  const client = await getDbPool().connect();
  try {
    await withSchemaDdlLock(client, async (db) => {
      await db.query(`CREATE TABLE IF NOT EXISTS oauth_login_handoffs (
        token_hash TEXT PRIMARY KEY,
        payload JSONB NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS oauth_login_handoffs_expiry ON oauth_login_handoffs(expires_at);`);
    });
    ready = true;
  } finally {
    client.release();
  }
}

const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export async function createOAuthHandoff(input: OAuthHandoff): Promise<string> {
  await ensureTable();
  const token = randomBytes(32).toString("hex");
  const { nsec, ...metadata } = input;
  const pool = getDbPool();
  await pool.query("DELETE FROM oauth_login_handoffs WHERE expires_at <= NOW()");
  await pool.query(
    `INSERT INTO oauth_login_handoffs (token_hash, payload, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '120 seconds')`,
    [digest(token), JSON.stringify({ ...metadata, encryptedNsec: encryptOauthNsec(nsec) })]
  );
  return token;
}

export async function consumeOAuthHandoff(token: string): Promise<OAuthHandoff | null> {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  await ensureTable();
  // DELETE RETURNING makes simultaneous requests/replay single-use across servers.
  const result = await getDbPool().query(
    `DELETE FROM oauth_login_handoffs WHERE token_hash = $1 AND expires_at > NOW() RETURNING payload`,
    [digest(token)]
  );
  const payload = result.rows[0]?.payload;
  if (!payload) return null;
  const { encryptedNsec, ...metadata } = payload;
  const { nsec } = decryptOauthNsec(encryptedNsec, metadata.provider, "");
  if (!nsec) throw new Error("OAuth handoff could not be decrypted");
  return { ...metadata, nsec };
}
