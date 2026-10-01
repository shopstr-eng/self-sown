// Persistence for the x402 integration:
//
// 1. `x402_settled_payments` — the replay store the lnbtc scheme requires:
//    every settled (network, payment hash) pair is recorded atomically so a
//    preimage can never be replayed to settle a second order. The row is also
//    the receipt linking a settled payment to its order.
//
// 2. Per-seller invoice-authority config — a Pro seller can point x402 (and
//    the shared Lightning MCP checkout) at their own LNbits instance so
//    invoices are issued by their own node with a spec-strict request
//    binding. Stored in pro_settings under a per-seller namespaced key; the
//    LNbits API key is encrypted at rest with the same AES-256-GCM helper
//    used for MCP nsecs (MCP_ENCRYPTION_KEY).

import { getDbPool } from "@/utils/db/db-service";
import { getProSetting, setProSetting } from "@/utils/db/pro-membership";
import { decryptNsec, encryptNsec } from "@/utils/mcp/nostr-signing";

export interface X402SettlementClaim {
  paymentHash: string;
  network: string;
  amountMsat: bigint;
  orderId: string;
  apiKeyId?: number;
  buyerPubkey?: string;
}

/**
 * Atomically record a settled payment hash. Returns true when this caller
 * created the row (and therefore owns the settlement side effects); false
 * means the payment hash was already settled — the spec's
 * `duplicate_settlement` case. Throws on DB error so callers fail loudly
 * rather than serving an unpaid resource.
 */
export async function claimX402Settlement(
  claim: X402SettlementClaim
): Promise<boolean> {
  const pool = getDbPool();
  let client;
  try {
    client = await pool.connect();
    const result = await client.query(
      `INSERT INTO x402_settled_payments
         (payment_hash, network, amount_msat, order_id, api_key_id, buyer_pubkey)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (payment_hash) DO NOTHING
       RETURNING payment_hash`,
      [
        claim.paymentHash,
        claim.network,
        claim.amountMsat.toString(),
        claim.orderId,
        claim.apiKeyId ?? null,
        claim.buyerPubkey ?? null,
      ]
    );
    return result.rows.length === 1;
  } finally {
    if (client) client.release();
  }
}

/** Fetch a prior settlement receipt by payment hash (idempotent retries). */
export async function getX402Settlement(
  paymentHash: string
): Promise<{ orderId: string | null } | null> {
  const pool = getDbPool();
  let client;
  try {
    client = await pool.connect();
    const result = await client.query(
      `SELECT order_id FROM x402_settled_payments WHERE payment_hash = $1`,
      [paymentHash]
    );
    if (result.rows.length === 0) return null;
    return { orderId: result.rows[0].order_id ?? null };
  } finally {
    if (client) client.release();
  }
}

export interface SellerX402AuthorityConfig {
  provider: "lnbits";
  url: string;
  apiKeyCiphertext: string;
  updatedAt: string;
}

const authorityKey = (pubkey: string) => `x402_authority:${pubkey}`;

export async function getSellerX402Authority(
  pubkey: string
): Promise<SellerX402AuthorityConfig | null> {
  const raw = await getProSetting(authorityKey(pubkey));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      parsed.provider === "lnbits" &&
      typeof parsed.url === "string" &&
      typeof parsed.apiKeyCiphertext === "string"
    ) {
      return {
        provider: "lnbits",
        url: parsed.url,
        apiKeyCiphertext: parsed.apiKeyCiphertext,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      };
    }
  } catch {
    // fall through to null
  }
  return null;
}

export async function saveSellerX402Authority(
  pubkey: string,
  config: { provider: "lnbits"; url: string; apiKey: string }
): Promise<void> {
  const stored: SellerX402AuthorityConfig = {
    provider: "lnbits",
    url: config.url,
    apiKeyCiphertext: encryptNsec(config.apiKey),
    updatedAt: new Date().toISOString(),
  };
  await setProSetting(authorityKey(pubkey), JSON.stringify(stored));
}

export async function deleteSellerX402Authority(pubkey: string): Promise<void> {
  const pool = getDbPool();
  let client;
  try {
    client = await pool.connect();
    await client.query(`DELETE FROM pro_settings WHERE key = $1`, [
      authorityKey(pubkey),
    ]);
  } finally {
    if (client) client.release();
  }
}

export function decryptAuthorityApiKey(
  config: SellerX402AuthorityConfig
): string {
  return decryptNsec(config.apiKeyCiphertext);
}
