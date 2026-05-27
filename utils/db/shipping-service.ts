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

export interface DailySpendStatus {
  spentUsd: number;
  capUsd: number;
  remainingUsd: number;
  windowStart: string;
  windowEnd: string;
}

const DEFAULT_DAILY_CAP_USD = Number(
  process.env.SHIPPO_PUBKEY_DAILY_CAP_USD || 200
);

function buildSpendStatus(spent: number): DailySpendStatus {
  const now = new Date();
  return {
    spentUsd: spent,
    capUsd: DEFAULT_DAILY_CAP_USD,
    remainingUsd: Math.max(0, DEFAULT_DAILY_CAP_USD - spent),
    windowStart: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    windowEnd: now.toISOString(),
  };
}

export async function getDailySpendForPubkey(
  pubkey: string
): Promise<DailySpendStatus> {
  const pool = getDbPool();
  const result = await pool.query<{ total: string | null }>(
    `SELECT COALESCE(SUM(rate_usd), 0)::text AS total
     FROM shipping_labels
     WHERE pubkey = $1
       AND purchased_at > NOW() - INTERVAL '24 hours'`,
    [pubkey]
  );
  const spent = Number(result.rows[0]?.total || 0);
  return buildSpendStatus(spent);
}

/**
 * Serialize label purchases per pubkey using a Postgres session-level
 * advisory lock. This prevents two concurrent buys from both passing the
 * pre-flight cap check (race-then-overshoot). The callback receives the
 * current spend status computed *inside* the lock and is expected to
 * perform the Shippo charge + persist the resulting label row before
 * returning. The lock is released in finally so a thrown Shippo error
 * never wedges a pubkey.
 */
export async function withPubkeySpendLock<T>(
  pubkey: string,
  fn: (status: DailySpendStatus) => Promise<T>
): Promise<T> {
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1)::bigint)", [
      pubkey,
    ]);
    const result = await client.query<{ total: string | null }>(
      `SELECT COALESCE(SUM(rate_usd), 0)::text AS total
       FROM shipping_labels
       WHERE pubkey = $1
         AND purchased_at > NOW() - INTERVAL '24 hours'`,
      [pubkey]
    );
    const spent = Number(result.rows[0]?.total || 0);
    return await fn(buildSpendStatus(spent));
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtext($1)::bigint)", [
        pubkey,
      ]);
    } catch {
      // best-effort; client.release() below will reset session state
    }
    client.release();
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
