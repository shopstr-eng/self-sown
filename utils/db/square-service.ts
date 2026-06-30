import { getDbPool } from "@/utils/db/db-service";

// --- Square OAuth connected accounts -------------------------------------
//
// Each seller connects their OWN Square account via OAuth. Square is an
// ALTERNATIVE card processor to Stripe; a seller uses EITHER one, never both
// (mutual exclusion is enforced server-side at connect time). Square access
// tokens EXPIRE (~30 days), so the access token, refresh token and expiry are
// stored TOGETHER and renewed via utils/square/square-api.ts before use.

export interface SquareConnectionRecord {
  pubkey: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  merchantId: string | null;
  locationId: string | null;
  locationCurrency: string | null;
  scope: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface SquareConnectionRow {
  pubkey: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null;
  merchant_id: string | null;
  location_id: string | null;
  location_currency: string | null;
  scope: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

function mapConnectionRow(row: SquareConnectionRow): SquareConnectionRecord {
  return {
    pubkey: row.pubkey,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    expiresAt: row.expires_at,
    merchantId: row.merchant_id,
    locationId: row.location_id,
    locationCurrency: row.location_currency,
    scope: row.scope,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface UpsertSquareConnectionInput {
  pubkey: string;
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: string | null;
  merchantId?: string | null;
  locationId?: string | null;
  locationCurrency?: string | null;
  scope?: string | null;
  status?: string;
}

export async function upsertSquareConnection(
  input: UpsertSquareConnectionInput
): Promise<SquareConnectionRecord> {
  const pool = getDbPool();
  const result = await pool.query<SquareConnectionRow>(
    `INSERT INTO square_oauth_connections
       (pubkey, access_token, refresh_token, expires_at, merchant_id,
        location_id, location_currency, scope, status, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
     ON CONFLICT (pubkey) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       expires_at = EXCLUDED.expires_at,
       merchant_id = EXCLUDED.merchant_id,
       location_id = EXCLUDED.location_id,
       location_currency = EXCLUDED.location_currency,
       scope = EXCLUDED.scope,
       status = EXCLUDED.status,
       updated_at = NOW()
     RETURNING *`,
    [
      input.pubkey,
      input.accessToken,
      input.refreshToken ?? null,
      input.expiresAt ?? null,
      input.merchantId ?? null,
      input.locationId ?? null,
      input.locationCurrency ?? null,
      input.scope ?? null,
      input.status ?? "connected",
    ]
  );
  const row = result.rows[0];
  if (!row) throw new Error("Failed to upsert Square connection");
  return mapConnectionRow(row);
}

export async function getSquareConnection(
  pubkey: string
): Promise<SquareConnectionRecord | null> {
  const pool = getDbPool();
  const result = await pool.query<SquareConnectionRow>(
    `SELECT * FROM square_oauth_connections WHERE pubkey = $1 LIMIT 1`,
    [pubkey]
  );
  return result.rows[0] ? mapConnectionRow(result.rows[0]) : null;
}

// Lightweight existence check used by the bidirectional Stripe↔Square mutual
// exclusion guards (don't pull tokens just to check connectivity).
export async function hasSquareConnection(pubkey: string): Promise<boolean> {
  const pool = getDbPool();
  const result = await pool.query<{ one: number }>(
    `SELECT 1 AS one FROM square_oauth_connections
     WHERE pubkey = $1 AND status = 'connected' LIMIT 1`,
    [pubkey]
  );
  return result.rows.length > 0;
}

export interface UpdateSquareTokensInput {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: string | null;
}

// Persist a refreshed token set. refresh_token is COALESCE'd so a refresh
// response that omits it keeps the existing one (Square does not always rotate
// it). merchant/location/currency are intentionally untouched.
export async function updateSquareTokens(
  pubkey: string,
  input: UpdateSquareTokensInput
): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `UPDATE square_oauth_connections
       SET access_token = $2,
           refresh_token = COALESCE($3, refresh_token),
           expires_at = $4,
           updated_at = NOW()
     WHERE pubkey = $1`,
    [
      pubkey,
      input.accessToken,
      input.refreshToken ?? null,
      input.expiresAt ?? null,
    ]
  );
}

export async function deleteSquareConnection(pubkey: string): Promise<boolean> {
  const pool = getDbPool();
  const result = await pool.query(
    `DELETE FROM square_oauth_connections WHERE pubkey = $1`,
    [pubkey]
  );
  return (result.rowCount || 0) > 0;
}

// --- Square OAuth state (CSRF + state→pubkey binding) --------------------
//
// Mirrors the Shippo flow: there are no server sessions, so the OAuth `state`
// is persisted briefly and mapped to the initiating pubkey. The callback (a
// plain browser redirect from Square with no signed event) is authorized solely
// by this single-use state.

const OAUTH_STATE_TTL_MINUTES = 15;

export async function createSquareOAuthState(
  pubkey: string,
  state: string
): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `DELETE FROM square_oauth_states
     WHERE created_at < NOW() - INTERVAL '${OAUTH_STATE_TTL_MINUTES} minutes'`
  );
  await pool.query(
    `INSERT INTO square_oauth_states (state, pubkey)
     VALUES ($1, $2)
     ON CONFLICT (state) DO NOTHING`,
    [state, pubkey]
  );
}

// Single-use: returns the bound pubkey and deletes the row. Null if unknown or
// expired.
export async function consumeSquareOAuthState(
  state: string
): Promise<string | null> {
  const pool = getDbPool();
  const result = await pool.query<{ pubkey: string }>(
    `DELETE FROM square_oauth_states
     WHERE state = $1
       AND created_at > NOW() - INTERVAL '${OAUTH_STATE_TTL_MINUTES} minutes'
     RETURNING pubkey`,
    [state]
  );
  return result.rows[0]?.pubkey || null;
}
