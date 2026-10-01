import { pbkdf2Sync, randomBytes, timingSafeEqual } from "crypto";
import type { NextApiRequest, NextApiResponse } from "next";
import type { PoolClient } from "pg";
import { getDbPool, withSchemaDdlLock } from "@/utils/db/db-service";
import { isPubkeyProEntitled } from "@/utils/pro/membership";
import { originFromHostHeader } from "@/utils/site-url";

// Shared "Pro required" message for MCP authentication failures so REST and
// JSON-RPC entry points surface identical copy.
export const MCP_PRO_REQUIRED_MESSAGE =
  "This API key's owner does not have an active Herd membership. MCP access requires Herd.";

/**
 * True when the API key's owning seller is currently Pro-entitled. Used by the
 * MCP auth chokepoints so existing keys stop working once a seller lapses.
 */
export async function isApiKeyOwnerProEntitled(
  apiKey: ApiKeyRecord
): Promise<boolean> {
  return isPubkeyProEntitled(apiKey.pubkey);
}

export type ApiKeyPermission = "read" | "read_write" | "full_access";

// Audience is the primary gate: "shopping" keys are free for any pubkey and
// reach catalog + purchase tooling; "seller" keys are Pro-gated and reach
// seller tooling. Legacy rows default to "seller" and keep their stored
// permissions tier, so an old "read" key is NOT escalated by the migration.
export type ApiKeyAudience = "shopping" | "seller";

export interface ApiKeyRecord {
  id: number;
  key_prefix: string;
  key_hash: string;
  name: string;
  pubkey: string;
  permissions: ApiKeyPermission;
  audience: ApiKeyAudience;
  created_at: string;
  last_used_at: string | null;
  is_active: boolean;
  encrypted_nsec?: string | null;
}

/** True for keys that can browse the catalog and place/track orders. */
export function canUsePurchaseTools(apiKey: ApiKeyRecord): boolean {
  return apiKey.audience === "shopping" || apiKey.permissions !== "read";
}

/** Seller-scoped reads (order/label/email dashboards). Seller keys only. */
export function canUseSellerReadTools(apiKey: ApiKeyRecord): boolean {
  return apiKey.audience !== "shopping" && apiKey.permissions !== "read";
}

/** Seller management tooling (write tools). Seller keys at full_access. */
export function canUseSellerWriteTools(apiKey: ApiKeyRecord): boolean {
  return apiKey.audience !== "shopping" && apiKey.permissions === "full_access";
}

export interface AuthenticatedRequest extends NextApiRequest {
  apiKey?: ApiKeyRecord;
}

// NOTE: A generic, unbound `verifyNostrAuth` (kind-27235 + signature +
// created_at window, but no method/path binding) used to live here. It was
// retired because an unbound signed event is replayable across endpoints
// within its freshness window. All authenticated MCP/Nostr write paths now go
// through the single-use, bound proof (`verifyAndConsumeSignedRequestProof` in
// `utils/nostr/request-auth`) or the `expectedBinding{method,path}` variant in
// `utils/stripe/verify-nostr-auth`. Do not reintroduce an unbound verifier.

export function hashApiKey(key: string): string {
  const salt = randomBytes(16);
  const iterations = 100_000;
  const derivedKey = pbkdf2Sync(
    key,
    Uint8Array.from(salt),
    iterations,
    32,
    "sha256"
  );
  const saltHex = salt.toString("hex");
  const hashHex = derivedKey.toString("hex");
  // format: algorithm$iterations$salt$hash
  return `pbkdf2_sha256$${iterations}$${saltHex}$${hashHex}`;
}

export function generateApiKey(): { key: string; prefix: string } {
  // Prefix rotated mm_ → ss_ in the Self-sown rebrand. Existing mm_ keys keep
  // working: lookup is by the presented key's own prefix + hash, and each
  // row's stored key_prefix was captured at creation time.
  const key = `ss_${randomBytes(32).toString("hex")}`;
  const prefix = key.substring(0, 10);
  return { key, prefix };
}

export async function initializeApiKeysTable(): Promise<void> {
  const pool = getDbPool();
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await withSchemaDdlLock(client, async (client) => {
      await client.query(`
      CREATE TABLE IF NOT EXISTS mcp_api_keys (
        id SERIAL PRIMARY KEY,
        key_prefix TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        pubkey TEXT NOT NULL,
        permissions TEXT NOT NULL DEFAULT 'read' CHECK (permissions IN ('read', 'read_write', 'full_access')),
        audience TEXT NOT NULL DEFAULT 'seller' CHECK (audience IN ('shopping', 'seller')),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_used_at TIMESTAMP,
        is_active BOOLEAN DEFAULT TRUE,
        encrypted_nsec TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_api_keys_key_hash ON mcp_api_keys(key_hash);
      CREATE INDEX IF NOT EXISTS idx_mcp_api_keys_pubkey ON mcp_api_keys(pubkey);

      CREATE TABLE IF NOT EXISTS mcp_request_proofs (
        event_id TEXT NOT NULL,
        pubkey TEXT NOT NULL,
        action TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_request_proofs_created_at ON mcp_request_proofs(created_at);

      CREATE TABLE IF NOT EXISTS mcp_orders (
        id SERIAL PRIMARY KEY,
        order_id TEXT NOT NULL UNIQUE,
        api_key_id INTEGER REFERENCES mcp_api_keys(id),
        buyer_pubkey TEXT NOT NULL,
        seller_pubkey TEXT NOT NULL,
        product_id TEXT NOT NULL,
        product_title TEXT,
        quantity INTEGER NOT NULL DEFAULT 1,
        amount_total NUMERIC(12,2) NOT NULL,
        currency TEXT NOT NULL DEFAULT 'usd',
        buyer_email TEXT,
        shipping_address JSONB,
        payment_intent_id TEXT,
        payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'processing', 'paid', 'failed', 'refunded')),
        order_status TEXT NOT NULL DEFAULT 'pending' CHECK (order_status IN ('pending', 'confirmed', 'shipped', 'delivered', 'cancelled')),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_orders_order_id ON mcp_orders(order_id);
      CREATE INDEX IF NOT EXISTS idx_mcp_orders_buyer_pubkey ON mcp_orders(buyer_pubkey);
      CREATE INDEX IF NOT EXISTS idx_mcp_orders_seller_pubkey ON mcp_orders(seller_pubkey);
      CREATE INDEX IF NOT EXISTS idx_mcp_orders_api_key_id ON mcp_orders(api_key_id);

      -- Pending Lightning quotes (one per order awaiting settlement).
      -- Persisted so verify-payment survives restarts / multi-instance polls;
      -- expires_at is TIMESTAMPTZ so the stored deadline is zone-independent.
      CREATE TABLE IF NOT EXISTS mcp_lightning_quotes (
        order_id TEXT PRIMARY KEY,
        quote TEXT NOT NULL,
        mint_url TEXT NOT NULL,
        amount BIGINT NOT NULL,
        product_id TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        inventory_variant_key TEXT NOT NULL DEFAULT '_default',
        discount_code TEXT,
        seller_pubkey TEXT,
        expires_at TIMESTAMPTZ,
        claimed_at TIMESTAMPTZ,
        payment_hash TEXT,
        authority TEXT NOT NULL DEFAULT 'mint',
        invoice TEXT,
        request_hash TEXT,
        authority_api_key TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_lightning_quotes_expires_at ON mcp_lightning_quotes(expires_at);

      -- x402 replay store (see db-service.ts; both initializers must agree).
      CREATE TABLE IF NOT EXISTS x402_settled_payments (
        payment_hash TEXT PRIMARY KEY,
        network TEXT NOT NULL,
        amount_msat BIGINT NOT NULL,
        order_id TEXT,
        api_key_id INTEGER,
        buyer_pubkey TEXT,
        settled_at TIMESTAMPTZ DEFAULT now()
      );
    `);

      // Optional migrations run under savepoints: the lock wrapper above holds
      // an explicit transaction, so a caught error would otherwise abort it and
      // silently roll back every preceding statement at COMMIT.
      const optionalMigration = async (run: () => Promise<void>) => {
        await client.query("SAVEPOINT mcp_optional_migration");
        try {
          await run();
          await client.query("RELEASE SAVEPOINT mcp_optional_migration");
        } catch {
          await client.query("ROLLBACK TO SAVEPOINT mcp_optional_migration");
        }
      };

      await optionalMigration(async () => {
        await client.query(
          `ALTER TABLE mcp_api_keys ADD COLUMN IF NOT EXISTS encrypted_nsec TEXT`
        );
      });

      // Audience split: existing rows backfill to 'seller' (their stored
      // permissions tier still applies, so nothing is escalated); shopping
      // keys are created explicitly.
      await optionalMigration(async () => {
        await client.query(
          `ALTER TABLE mcp_api_keys ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'seller'`
        );
        await client.query(
          `ALTER TABLE mcp_api_keys DROP CONSTRAINT IF EXISTS mcp_api_keys_audience_check`
        );
        await client.query(
          `ALTER TABLE mcp_api_keys ADD CONSTRAINT mcp_api_keys_audience_check CHECK (audience IN ('shopping', 'seller'))`
        );
      });

      // Self-migrate databases where initializeTables() (db-service.ts) created
      // mcp_orders first with its older column set — the CREATE above is a
      // no-op for them.
      await optionalMigration(async () => {
        await client.query(
          `ALTER TABLE mcp_orders ADD COLUMN IF NOT EXISTS buyer_email TEXT`
        );
        await client.query(
          `ALTER TABLE mcp_orders ADD COLUMN IF NOT EXISTS payment_intent_id TEXT`
        );
        await client.query(
          `ALTER TABLE mcp_orders ALTER COLUMN currency SET DEFAULT 'usd'`
        );
      });

      // Self-migrate databases where an initializer created
      // mcp_lightning_quotes before the settlement-claim column existed.
      await optionalMigration(async () => {
        await client.query(
          `ALTER TABLE mcp_lightning_quotes ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ`
        );
      });

      // x402 support: payment hash (preimage-settlement lookup), which
      // invoice authority issued the invoice (platform mint vs seller
      // LNbits), and the persisted challenge evidence (exact invoice, bound
      // request hash, authority credentials snapshot) that settlement and
      // polling verify against. The payment-hash index must be created AFTER
      // the column exists, or existing databases fail initialization here.
      await optionalMigration(async () => {
        await client.query(
          `ALTER TABLE mcp_lightning_quotes ADD COLUMN IF NOT EXISTS payment_hash TEXT`
        );
        await client.query(
          `ALTER TABLE mcp_lightning_quotes ADD COLUMN IF NOT EXISTS authority TEXT NOT NULL DEFAULT 'mint'`
        );
        await client.query(
          `ALTER TABLE mcp_lightning_quotes ADD COLUMN IF NOT EXISTS invoice TEXT`
        );
        await client.query(
          `ALTER TABLE mcp_lightning_quotes ADD COLUMN IF NOT EXISTS request_hash TEXT`
        );
        await client.query(
          `ALTER TABLE mcp_lightning_quotes ADD COLUMN IF NOT EXISTS authority_api_key TEXT`
        );
        await client.query(
          `CREATE INDEX IF NOT EXISTS idx_mcp_lightning_quotes_payment_hash ON mcp_lightning_quotes(payment_hash)`
        );
      });

      await optionalMigration(async () => {
        await client.query(
          `ALTER TABLE mcp_api_keys DROP CONSTRAINT IF EXISTS mcp_api_keys_permissions_check`
        );
        await client.query(
          `ALTER TABLE mcp_api_keys ADD CONSTRAINT mcp_api_keys_permissions_check CHECK (permissions IN ('read', 'read_write', 'full_access'))`
        );
      });
    });
  } catch (error) {
    console.error("Failed to initialize MCP tables:", error);
    throw error;
  } finally {
    if (client) client.release();
  }
}

export async function createApiKey(
  name: string,
  pubkey: string,
  permissions: ApiKeyPermission = "read",
  encryptedNsec?: string,
  audience: ApiKeyAudience = "seller"
): Promise<{ key: string; record: ApiKeyRecord }> {
  const { key, prefix } = generateApiKey();
  const keyHash = hashApiKey(key);

  const pool = getDbPool();
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    const result = await client.query(
      `INSERT INTO mcp_api_keys (key_prefix, key_hash, name, pubkey, permissions, audience, encrypted_nsec)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        prefix,
        keyHash,
        name,
        pubkey,
        permissions,
        audience,
        encryptedNsec || null,
      ] as any[]
    );
    return { key, record: result.rows[0] };
  } finally {
    if (client) client.release();
  }
}

export async function updateApiKeyNsec(
  id: number,
  pubkey: string,
  encryptedNsec: string,
  permissions?: ApiKeyPermission
): Promise<boolean> {
  const pool = getDbPool();
  let client;
  try {
    client = await pool.connect();
    const query = permissions
      ? `UPDATE mcp_api_keys SET encrypted_nsec = $1, permissions = $2 WHERE id = $3 AND pubkey = $4 AND is_active = TRUE`
      : `UPDATE mcp_api_keys SET encrypted_nsec = $1 WHERE id = $2 AND pubkey = $3 AND is_active = TRUE`;
    const params = permissions
      ? [encryptedNsec, permissions, id, pubkey]
      : [encryptedNsec, id, pubkey];
    const result = await client.query(query, params as any[]);
    return (result.rowCount ?? 0) > 0;
  } finally {
    if (client) client.release();
  }
}

export async function getAgentSigner(
  apiKey: ApiKeyRecord
): Promise<{ signer: any; pubkey: string } | null> {
  if (!apiKey.encrypted_nsec) return null;
  try {
    const { decryptNsec, McpNostrSigner } =
      await import("@/utils/mcp/nostr-signing");
    const nsec = decryptNsec(apiKey.encrypted_nsec);
    const signer = new McpNostrSigner(nsec);
    return { signer, pubkey: signer.getPubKey() };
  } catch (error) {
    console.error("Failed to create agent signer:", error);
    return null;
  }
}

export function verifyApiKey(key: string, storedHash: string): boolean {
  const parts = storedHash.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2_sha256") return false;
  const iterations = parseInt(parts[1]!, 10);
  const salt = Buffer.from(parts[2]!, "hex");
  const expectedKey = Buffer.from(parts[3]!, "hex");
  const derivedKey = pbkdf2Sync(
    key,
    Uint8Array.from(salt),
    iterations,
    expectedKey.length,
    "sha256"
  );
  return timingSafeEqual(
    Uint8Array.from(derivedKey),
    Uint8Array.from(expectedKey)
  );
}

export async function validateApiKey(
  key: string
): Promise<ApiKeyRecord | null> {
  const prefix = key.substring(0, 10);

  const pool = getDbPool();
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    const result = await client.query(
      `SELECT * FROM mcp_api_keys WHERE key_prefix = $1 AND is_active = TRUE`,
      [prefix]
    );

    const match = result.rows.find((row: ApiKeyRecord) =>
      verifyApiKey(key, row.key_hash)
    );
    if (!match) return null;

    await client.query(
      `UPDATE mcp_api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [match.id]
    );

    return match;
  } finally {
    if (client) client.release();
  }
}

export async function listApiKeys(pubkey: string): Promise<ApiKeyRecord[]> {
  const pool = getDbPool();
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    const result = await client.query(
      `SELECT id, key_prefix, name, pubkey, permissions, audience, created_at, last_used_at, is_active
       FROM mcp_api_keys WHERE pubkey = $1 ORDER BY created_at DESC`,
      [pubkey]
    );
    return result.rows;
  } finally {
    if (client) client.release();
  }
}

export async function revokeApiKey(
  id: number,
  pubkey: string
): Promise<boolean> {
  const pool = getDbPool();
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    const result = await client.query(
      `UPDATE mcp_api_keys SET is_active = FALSE WHERE id = $1 AND pubkey = $2`,
      [String(id), pubkey]
    );
    return (result.rowCount ?? 0) > 0;
  } finally {
    if (client) client.release();
  }
}

/**
 * Deactivate a seller's MCP API keys at once. Called when a seller drops off
 * the paid (Herd/Wrangler) tier so their agents can no longer manage the shop
 * via MCP on a free plan. Only SELLER-audience keys are deactivated: shopping
 * keys are free for everyone and must survive a membership lapse (a lapsed
 * seller is still a shopper). Deactivation (not hard delete) keeps the rows
 * so the `api_key_id` foreign key on MCP orders stays intact, while
 * `validateApiKey` — which only matches `is_active = TRUE` keys — immediately
 * rejects them. Idempotent: only flips currently-active keys and returns how
 * many it revoked.
 */
export async function deactivateApiKeysForPubkey(
  pubkey: string
): Promise<number> {
  const pool = getDbPool();
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    const result = await client.query(
      `UPDATE mcp_api_keys SET is_active = FALSE WHERE pubkey = $1 AND is_active = TRUE AND audience = 'seller'`,
      [pubkey]
    );
    return result.rowCount ?? 0;
  } finally {
    if (client) client.release();
  }
}

export function extractBearerToken(req: NextApiRequest): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  return authHeader.substring(7);
}

// RFC 9728 §5.1: a 401 from a protected resource should point agents at the
// resource-metadata document via the WWW-Authenticate challenge so they can
// discover scopes_supported and self-serve a correctly-scoped key. The URL is
// host-derived because the same API answers on seller custom domains, and the
// metadata document there carries that host as its `resource`.
function setAuthChallenge(req: NextApiRequest, res: NextApiResponse): void {
  const origin = originFromHostHeader(req.headers.host);
  res.setHeader(
    "WWW-Authenticate",
    `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`
  );
}

export async function authenticateRequest(
  req: NextApiRequest,
  res: NextApiResponse,
  requiredPermission?: ApiKeyPermission
): Promise<ApiKeyRecord | null> {
  const token = extractBearerToken(req);
  if (!token) {
    setAuthChallenge(req, res);
    res
      .status(401)
      .json({ error: "Missing API key. Use Authorization: Bearer <key>" });
    return null;
  }

  const apiKey = await validateApiKey(token);
  if (!apiKey) {
    setAuthChallenge(req, res);
    res.status(401).json({ error: "Invalid or revoked API key" });
    return null;
  }

  // Seller tooling is Pro-gated: reject seller keys whose owner is no longer
  // entitled, so access tracks the membership lifecycle even for keys created
  // while the seller was entitled. Shopping keys are free for every pubkey
  // and skip this check entirely.
  if (
    apiKey.audience !== "shopping" &&
    !(await isApiKeyOwnerProEntitled(apiKey))
  ) {
    res.status(403).json({ error: MCP_PRO_REQUIRED_MESSAGE });
    return null;
  }

  if (requiredPermission === "read_write" && !canUsePurchaseTools(apiKey)) {
    res.status(403).json({
      error:
        "Insufficient permissions. This action requires a shopping API key or a seller key with purchase access.",
    });
    return null;
  }

  if (requiredPermission === "full_access" && !canUseSellerWriteTools(apiKey)) {
    res.status(403).json({
      error: "Insufficient permissions. This action requires a seller API key.",
    });
    return null;
  }

  return apiKey;
}
