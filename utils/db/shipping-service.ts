import { getDbPool } from "@/utils/db/db-service";

export interface ShippingLabelRecord {
  id: number;
  pubkey: string;
  shipmentId: string;
  orderId: string | null;
  trackingCode: string | null;
  trackingUrl: string | null;
  labelUrl: string;
  labelFormat: string | null;
  rateUsd: number;
  currency: string;
  carrier: string | null;
  service: string | null;
  isReturn: boolean;
  fromSummary: string | null;
  toSummary: string | null;
  parcelSummary: string | null;
  purchasedAt: string;
}

export interface ParcelTemplateRecord {
  id: number;
  pubkey: string;
  name: string;
  weightOz: number;
  lengthIn: number | null;
  widthIn: number | null;
  heightIn: number | null;
  createdAt: string;
}

export interface ShippingDefaultsRecord {
  pubkey: string;
  fromName: string | null;
  fromCompany: string | null;
  fromStreet1: string | null;
  fromStreet2: string | null;
  fromCity: string | null;
  fromState: string | null;
  fromZip: string | null;
  fromCountry: string;
  fromPhone: string | null;
  fromEmail: string | null;
  preferredCarriers: string[];
  updatedAt: string;
}

interface ShippingLabelRow {
  id: number;
  pubkey: string;
  shipment_id: string;
  order_id: string | null;
  tracking_code: string | null;
  tracking_url: string | null;
  label_url: string;
  label_format: string | null;
  rate_usd: string;
  currency: string;
  carrier: string | null;
  service: string | null;
  is_return: boolean;
  from_summary: string | null;
  to_summary: string | null;
  parcel_summary: string | null;
  purchased_at: string;
}

function mapLabelRow(row: ShippingLabelRow): ShippingLabelRecord {
  return {
    id: row.id,
    pubkey: row.pubkey,
    shipmentId: row.shipment_id,
    orderId: row.order_id,
    trackingCode: row.tracking_code,
    trackingUrl: row.tracking_url,
    labelUrl: row.label_url,
    labelFormat: row.label_format,
    rateUsd: Number(row.rate_usd),
    currency: row.currency,
    carrier: row.carrier,
    service: row.service,
    isReturn: row.is_return,
    fromSummary: row.from_summary,
    toSummary: row.to_summary,
    parcelSummary: row.parcel_summary,
    purchasedAt: row.purchased_at,
  };
}

export interface InsertShippingLabelInput {
  pubkey: string;
  shipmentId: string;
  orderId?: string | null;
  trackingCode?: string | null;
  trackingUrl?: string | null;
  labelUrl: string;
  labelFormat?: string | null;
  rateUsd: number;
  currency: string;
  carrier?: string | null;
  service?: string | null;
  isReturn?: boolean;
  fromSummary?: string | null;
  toSummary?: string | null;
  parcelSummary?: string | null;
}

export async function insertShippingLabel(
  input: InsertShippingLabelInput
): Promise<ShippingLabelRecord> {
  const pool = getDbPool();
  const result = await pool.query<ShippingLabelRow>(
    `INSERT INTO shipping_labels (
       pubkey, shipment_id, order_id, tracking_code, tracking_url,
       label_url, label_format, rate_usd, currency, carrier, service,
       is_return, from_summary, to_summary, parcel_summary
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
     )
     RETURNING *`,
    [
      input.pubkey,
      input.shipmentId,
      input.orderId ?? null,
      input.trackingCode ?? null,
      input.trackingUrl ?? null,
      input.labelUrl,
      input.labelFormat ?? null,
      input.rateUsd,
      input.currency,
      input.carrier ?? null,
      input.service ?? null,
      !!input.isReturn,
      input.fromSummary ?? null,
      input.toSummary ?? null,
      input.parcelSummary ?? null,
    ]
  );
  const row = result.rows[0];
  if (!row) throw new Error("Failed to insert shipping label");
  return mapLabelRow(row);
}

export async function listShippingLabelsForPubkey(
  pubkey: string,
  limit = 100
): Promise<ShippingLabelRecord[]> {
  const pool = getDbPool();
  const result = await pool.query<ShippingLabelRow>(
    `SELECT * FROM shipping_labels
     WHERE pubkey = $1
     ORDER BY purchased_at DESC
     LIMIT $2`,
    [pubkey, limit]
  );
  return result.rows.map(mapLabelRow);
}

export async function getShippingLabelForPubkey(
  pubkey: string,
  id: number
): Promise<ShippingLabelRecord | null> {
  const pool = getDbPool();
  const result = await pool.query<ShippingLabelRow>(
    `SELECT * FROM shipping_labels WHERE pubkey = $1 AND id = $2 LIMIT 1`,
    [pubkey, id]
  );
  return result.rows[0] ? mapLabelRow(result.rows[0]) : null;
}

// --- Shippo OAuth connected accounts -------------------------------------
//
// Each seller connects their OWN Shippo account via OAuth. The access token
// (prefix `oauth.`) never expires, so there is no refresh flow. Shippo bills
// the seller directly — the platform holds no balance and enforces no spend
// caps. Tokens are stored per pubkey.

export interface ShippoConnectionRecord {
  pubkey: string;
  accessToken: string;
  accountId: string | null;
  scope: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface ShippoConnectionRow {
  pubkey: string;
  access_token: string;
  account_id: string | null;
  scope: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

function mapConnectionRow(row: ShippoConnectionRow): ShippoConnectionRecord {
  return {
    pubkey: row.pubkey,
    accessToken: row.access_token,
    accountId: row.account_id,
    scope: row.scope,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface UpsertShippoConnectionInput {
  pubkey: string;
  accessToken: string;
  accountId?: string | null;
  scope?: string | null;
  status?: string;
}

export async function upsertShippoConnection(
  input: UpsertShippoConnectionInput
): Promise<ShippoConnectionRecord> {
  const pool = getDbPool();
  const result = await pool.query<ShippoConnectionRow>(
    `INSERT INTO shipping_oauth_connections
       (pubkey, access_token, account_id, scope, status, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (pubkey) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       account_id = EXCLUDED.account_id,
       scope = EXCLUDED.scope,
       status = EXCLUDED.status,
       updated_at = NOW()
     RETURNING *`,
    [
      input.pubkey,
      input.accessToken,
      input.accountId ?? null,
      input.scope ?? null,
      input.status ?? "connected",
    ]
  );
  const row = result.rows[0];
  if (!row) throw new Error("Failed to upsert Shippo connection");
  return mapConnectionRow(row);
}

export async function getShippoConnection(
  pubkey: string
): Promise<ShippoConnectionRecord | null> {
  const pool = getDbPool();
  const result = await pool.query<ShippoConnectionRow>(
    `SELECT * FROM shipping_oauth_connections WHERE pubkey = $1 LIMIT 1`,
    [pubkey]
  );
  return result.rows[0] ? mapConnectionRow(result.rows[0]) : null;
}

// Resolve just the bearer token for a seller, or null if not connected.
export async function getShippoAccessToken(
  pubkey: string
): Promise<string | null> {
  const conn = await getShippoConnection(pubkey);
  return conn?.accessToken || null;
}

export async function deleteShippoConnection(pubkey: string): Promise<boolean> {
  const pool = getDbPool();
  const result = await pool.query(
    `DELETE FROM shipping_oauth_connections WHERE pubkey = $1`,
    [pubkey]
  );
  return (result.rowCount || 0) > 0;
}

// --- Shippo OAuth state (CSRF + state→pubkey binding) --------------------
//
// There are no server sessions, so the OAuth `state` is persisted briefly and
// mapped to the initiating pubkey. The callback (a plain browser redirect from
// Shippo with no signed event) is authorized solely by this single-use state.

const OAUTH_STATE_TTL_MINUTES = 15;

export async function createShippoOAuthState(
  pubkey: string,
  state: string
): Promise<void> {
  const pool = getDbPool();
  // Opportunistic cleanup of expired states.
  await pool.query(
    `DELETE FROM shipping_oauth_states
     WHERE created_at < NOW() - INTERVAL '${OAUTH_STATE_TTL_MINUTES} minutes'`
  );
  await pool.query(
    `INSERT INTO shipping_oauth_states (state, pubkey)
     VALUES ($1, $2)
     ON CONFLICT (state) DO NOTHING`,
    [state, pubkey]
  );
}

// Single-use: returns the bound pubkey and deletes the row. Returns null if the
// state is unknown or expired.
export async function consumeShippoOAuthState(
  state: string
): Promise<string | null> {
  const pool = getDbPool();
  const result = await pool.query<{ pubkey: string }>(
    `DELETE FROM shipping_oauth_states
     WHERE state = $1
       AND created_at > NOW() - INTERVAL '${OAUTH_STATE_TTL_MINUTES} minutes'
     RETURNING pubkey`,
    [state]
  );
  return result.rows[0]?.pubkey || null;
}

// --- Shipment registry: ownership + duplicate-purchase guard -------------
//
// A single cross-instance table backs two things:
//   1. Ownership — which seller pubkey quoted a shipment (via /rates). Only
//      that pubkey may buy the label, so this must be visible to every server
//      instance, not just the one that handled the quote.
//   2. Duplicate-purchase guard — an atomic claim so two concurrent buys of
//      the same shipment can never both succeed (a double charge).
//
// Rows are transient; `pruneShipmentClaims` removes stale ones. The permanent
// record of a purchased label lives in `shipping_labels`.

// How long a quoted shipment stays purchasable after it was registered.
const SHIPMENT_OWNER_TTL_MINUTES = 30;

// Register (or refresh) the seller that owns a freshly quoted shipment. A row
// that has already advanced to 'purchased' is left untouched so a late re-quote
// can't reopen it for a second purchase.
export async function rememberShipmentOwner(
  shipmentId: string,
  pubkey: string
): Promise<void> {
  if (!shipmentId || !pubkey) return;
  const pool = getDbPool();
  await pool.query(
    `INSERT INTO shipping_shipment_claims (shipment_id, pubkey, status, updated_at)
     VALUES ($1, $2, 'owned', NOW())
     ON CONFLICT (shipment_id) DO UPDATE SET
       pubkey = EXCLUDED.pubkey,
       updated_at = NOW()
     WHERE shipping_shipment_claims.status = 'owned'`,
    [shipmentId, pubkey]
  );
  void pruneShipmentClaimsThrottled();
}

// Returns the owning pubkey if the shipment was registered within the TTL,
// regardless of whether it has since been purchased (so the caller can still
// distinguish "already purchased" from "never quoted"). Null if unknown/expired.
export async function getShipmentOwner(
  shipmentId: string
): Promise<string | null> {
  if (!shipmentId) return null;
  const pool = getDbPool();
  const result = await pool.query<{ pubkey: string }>(
    `SELECT pubkey FROM shipping_shipment_claims
     WHERE shipment_id = $1
       AND created_at > NOW() - INTERVAL '${SHIPMENT_OWNER_TTL_MINUTES} minutes'
     LIMIT 1`,
    [shipmentId]
  );
  return result.rows[0]?.pubkey || null;
}

// Atomically claim a shipment for purchase. Returns true if the caller now owns
// the claim, false if it was already claimed/purchased. Works for both:
//   - outbound labels: an 'owned' row exists (from rates) and is flipped to
//     'purchased';
//   - return labels: no prior row exists, so the row is inserted directly as
//     'purchased' (the caller passes a deterministic idempotency key).
// The DB enforces atomicity, so concurrent requests across any number of
// instances resolve to exactly one winner. The winner MUST call
// `releaseShipmentClaim` if the purchase ultimately fails, so it can be retried.
export async function claimShipmentForPurchase(
  shipmentId: string,
  pubkey: string
): Promise<boolean> {
  if (!shipmentId || !pubkey) return false;
  const pool = getDbPool();
  const result = await pool.query(
    `INSERT INTO shipping_shipment_claims (shipment_id, pubkey, status, updated_at)
     VALUES ($1, $2, 'purchased', NOW())
     ON CONFLICT (shipment_id) DO UPDATE SET
       status = 'purchased',
       updated_at = NOW()
     WHERE shipping_shipment_claims.status = 'owned'
     RETURNING shipment_id`,
    [shipmentId, pubkey]
  );
  void pruneShipmentClaimsThrottled();
  return (result.rowCount || 0) > 0;
}

// Revert a claim back to 'owned' so the shipment can be retried after a failed
// purchase. (Reverting rather than deleting preserves ownership for outbound
// retries; leftover return-label rows are pruned automatically.)
export async function releaseShipmentClaim(shipmentId: string): Promise<void> {
  if (!shipmentId) return;
  const pool = getDbPool();
  await pool.query(
    `UPDATE shipping_shipment_claims
       SET status = 'owned', updated_at = NOW()
     WHERE shipment_id = $1 AND status = 'purchased'`,
    [shipmentId]
  );
}

// Delete stale registry rows: 'owned' rows past the ownership window, and
// 'purchased' rows older than a generous retention (the permanent record is in
// shipping_labels). Returns the number of rows removed.
export async function pruneShipmentClaims(): Promise<number> {
  const pool = getDbPool();
  const result = await pool.query(
    `DELETE FROM shipping_shipment_claims
     WHERE (status = 'owned' AND created_at < NOW() - INTERVAL '1 hour')
        OR (status = 'purchased' AND created_at < NOW() - INTERVAL '7 days')`
  );
  return result.rowCount || 0;
}

// Throttled, fire-and-forget cleanup so the table never grows unbounded without
// requiring an external cron. Runs at most once per interval per instance.
const PRUNE_INTERVAL_MS = 10 * 60 * 1000;
let lastPruneAt = 0;

async function pruneShipmentClaimsThrottled(): Promise<void> {
  const now = Date.now();
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;
  try {
    await pruneShipmentClaims();
  } catch (err) {
    // Non-fatal: cleanup is best-effort and will retry on the next call.
    console.warn("pruneShipmentClaims failed:", err);
  }
}

// --- Parcel templates ----------------------------------------------------

interface ParcelTemplateRow {
  id: number;
  pubkey: string;
  name: string;
  weight_oz: string;
  length_in: string | null;
  width_in: string | null;
  height_in: string | null;
  created_at: string;
}

function mapTemplateRow(row: ParcelTemplateRow): ParcelTemplateRecord {
  return {
    id: row.id,
    pubkey: row.pubkey,
    name: row.name,
    weightOz: Number(row.weight_oz),
    lengthIn: row.length_in === null ? null : Number(row.length_in),
    widthIn: row.width_in === null ? null : Number(row.width_in),
    heightIn: row.height_in === null ? null : Number(row.height_in),
    createdAt: row.created_at,
  };
}

export async function listParcelTemplatesForPubkey(
  pubkey: string
): Promise<ParcelTemplateRecord[]> {
  const pool = getDbPool();
  const result = await pool.query<ParcelTemplateRow>(
    `SELECT * FROM shipping_parcel_templates
     WHERE pubkey = $1
     ORDER BY name ASC`,
    [pubkey]
  );
  return result.rows.map(mapTemplateRow);
}

export interface UpsertParcelTemplateInput {
  pubkey: string;
  name: string;
  weightOz: number;
  lengthIn?: number | null;
  widthIn?: number | null;
  heightIn?: number | null;
}

export async function upsertParcelTemplate(
  input: UpsertParcelTemplateInput
): Promise<ParcelTemplateRecord> {
  const pool = getDbPool();
  const result = await pool.query<ParcelTemplateRow>(
    `INSERT INTO shipping_parcel_templates
       (pubkey, name, weight_oz, length_in, width_in, height_in)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (pubkey, name) DO UPDATE SET
       weight_oz = EXCLUDED.weight_oz,
       length_in = EXCLUDED.length_in,
       width_in = EXCLUDED.width_in,
       height_in = EXCLUDED.height_in
     RETURNING *`,
    [
      input.pubkey,
      input.name,
      input.weightOz,
      input.lengthIn ?? null,
      input.widthIn ?? null,
      input.heightIn ?? null,
    ]
  );
  const row = result.rows[0];
  if (!row) throw new Error("Failed to upsert parcel template");
  return mapTemplateRow(row);
}

export async function deleteParcelTemplate(
  pubkey: string,
  id: number
): Promise<boolean> {
  const pool = getDbPool();
  const result = await pool.query(
    `DELETE FROM shipping_parcel_templates WHERE pubkey = $1 AND id = $2`,
    [pubkey, id]
  );
  return (result.rowCount || 0) > 0;
}

// --- Shop shipping defaults ---------------------------------------------

interface ShippingDefaultsRow {
  pubkey: string;
  from_name: string | null;
  from_company: string | null;
  from_street1: string | null;
  from_street2: string | null;
  from_city: string | null;
  from_state: string | null;
  from_zip: string | null;
  from_country: string | null;
  from_phone: string | null;
  from_email: string | null;
  preferred_carriers: string;
  updated_at: string;
}

function mapDefaultsRow(row: ShippingDefaultsRow): ShippingDefaultsRecord {
  const carriers = (row.preferred_carriers || "USPS")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  return {
    pubkey: row.pubkey,
    fromName: row.from_name,
    fromCompany: row.from_company,
    fromStreet1: row.from_street1,
    fromStreet2: row.from_street2,
    fromCity: row.from_city,
    fromState: row.from_state,
    fromZip: row.from_zip,
    fromCountry: row.from_country || "US",
    fromPhone: row.from_phone,
    fromEmail: row.from_email,
    preferredCarriers: carriers.length > 0 ? carriers : ["USPS"],
    updatedAt: row.updated_at,
  };
}

export async function getShippingDefaultsForPubkey(
  pubkey: string
): Promise<ShippingDefaultsRecord | null> {
  const pool = getDbPool();
  const result = await pool.query<ShippingDefaultsRow>(
    `SELECT * FROM shipping_defaults WHERE pubkey = $1`,
    [pubkey]
  );
  return result.rows[0] ? mapDefaultsRow(result.rows[0]) : null;
}

export interface UpsertShippingDefaultsInput {
  pubkey: string;
  fromName?: string | null;
  fromCompany?: string | null;
  fromStreet1?: string | null;
  fromStreet2?: string | null;
  fromCity?: string | null;
  fromState?: string | null;
  fromZip?: string | null;
  fromCountry?: string | null;
  fromPhone?: string | null;
  fromEmail?: string | null;
  preferredCarriers?: string[];
}

export async function upsertShippingDefaults(
  input: UpsertShippingDefaultsInput
): Promise<ShippingDefaultsRecord> {
  const pool = getDbPool();
  const carriersCsv = (input.preferredCarriers || ["USPS"]).join(",");
  const result = await pool.query<ShippingDefaultsRow>(
    `INSERT INTO shipping_defaults (
       pubkey, from_name, from_company, from_street1, from_street2,
       from_city, from_state, from_zip, from_country, from_phone, from_email,
       preferred_carriers, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
     ON CONFLICT (pubkey) DO UPDATE SET
       from_name = EXCLUDED.from_name,
       from_company = EXCLUDED.from_company,
       from_street1 = EXCLUDED.from_street1,
       from_street2 = EXCLUDED.from_street2,
       from_city = EXCLUDED.from_city,
       from_state = EXCLUDED.from_state,
       from_zip = EXCLUDED.from_zip,
       from_country = EXCLUDED.from_country,
       from_phone = EXCLUDED.from_phone,
       from_email = EXCLUDED.from_email,
       preferred_carriers = EXCLUDED.preferred_carriers,
       updated_at = NOW()
     RETURNING *`,
    [
      input.pubkey,
      input.fromName ?? null,
      input.fromCompany ?? null,
      input.fromStreet1 ?? null,
      input.fromStreet2 ?? null,
      input.fromCity ?? null,
      input.fromState ?? null,
      input.fromZip ?? null,
      input.fromCountry ?? "US",
      input.fromPhone ?? null,
      input.fromEmail ?? null,
      carriersCsv,
    ]
  );
  const row = result.rows[0];
  if (!row) throw new Error("Failed to upsert shipping defaults");
  return mapDefaultsRow(row);
}
