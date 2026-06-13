import { getDbPool } from "./db-service";
import type { StoredDnsRecord } from "@/utils/email/sendgrid-domain-auth";

export interface EmailSenderDomainRow {
  id: number;
  pubkey: string;
  domain: string;
  sendgrid_domain_id: number | null;
  subdomain: string | null;
  dns_records: StoredDnsRecord[] | null;
  valid: boolean;
  from_email: string | null;
  last_validation_at: string | null;
  created_at: string;
  updated_at: string;
}

const pool = getDbPool();

export async function getByPubkey(
  pubkey: string
): Promise<EmailSenderDomainRow | null> {
  const r = await pool.query<EmailSenderDomainRow>(
    `SELECT * FROM email_sender_domains WHERE pubkey = $1 LIMIT 1`,
    [pubkey]
  );
  return r.rows[0] ?? null;
}

export async function getByDomain(
  domain: string
): Promise<EmailSenderDomainRow | null> {
  const r = await pool.query<EmailSenderDomainRow>(
    `SELECT * FROM email_sender_domains WHERE domain = $1 LIMIT 1`,
    [domain.toLowerCase()]
  );
  return r.rows[0] ?? null;
}

/**
 * Create (or replace, for the same seller) a pending domain authentication.
 * Resets validation + the chosen from-email because the DNS identity changed.
 */
export async function upsertPending(params: {
  pubkey: string;
  domain: string;
  sendgridDomainId: number;
  subdomain: string | null;
  dnsRecords: StoredDnsRecord[];
  valid: boolean;
}): Promise<EmailSenderDomainRow> {
  const r = await pool.query<EmailSenderDomainRow>(
    `INSERT INTO email_sender_domains
       (pubkey, domain, sendgrid_domain_id, subdomain, dns_records, valid, from_email, last_validation_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, NULL, NULL)
     ON CONFLICT (pubkey) DO UPDATE SET
       domain = EXCLUDED.domain,
       sendgrid_domain_id = EXCLUDED.sendgrid_domain_id,
       subdomain = EXCLUDED.subdomain,
       dns_records = EXCLUDED.dns_records,
       valid = EXCLUDED.valid,
       from_email = NULL,
       last_validation_at = NULL,
       updated_at = NOW()
     RETURNING *`,
    [
      params.pubkey,
      params.domain.toLowerCase(),
      params.sendgridDomainId,
      params.subdomain,
      JSON.stringify(params.dnsRecords ?? []),
      params.valid,
    ]
  );
  return r.rows[0]!;
}

export async function markValidated(
  pubkey: string,
  valid: boolean,
  dnsRecords: StoredDnsRecord[]
): Promise<void> {
  await pool.query(
    `UPDATE email_sender_domains
       SET valid = $2,
           dns_records = $3::jsonb,
           last_validation_at = NOW(),
           updated_at = NOW()
     WHERE pubkey = $1`,
    [pubkey, valid, JSON.stringify(dnsRecords ?? [])]
  );
}

export async function setFromEmail(
  pubkey: string,
  fromEmail: string
): Promise<void> {
  await pool.query(
    `UPDATE email_sender_domains
       SET from_email = $2, updated_at = NOW()
     WHERE pubkey = $1`,
    [pubkey, fromEmail.toLowerCase()]
  );
}

export async function deleteByPubkey(pubkey: string): Promise<void> {
  await pool.query(`DELETE FROM email_sender_domains WHERE pubkey = $1`, [
    pubkey,
  ]);
}

/**
 * Validate that `email` is a single address whose host is EXACTLY the
 * authenticated `domain`. Exact match (not a suffix) keeps the guarantee that
 * SendGrid will accept the sender, since the authenticated domain is what was
 * DKIM-verified.
 */
export function isValidFromEmail(email: string, domain: string): boolean {
  if (!email || !domain) return false;
  const e = email.trim().toLowerCase();
  const d = domain.trim().toLowerCase();
  const m = /^[a-z0-9._%+-]+@([a-z0-9.-]+)$/.exec(e);
  if (!m) return false;
  return m[1] === d;
}

/**
 * Fail-closed resolver: returns the seller's custom from-address ONLY when the
 * domain is SendGrid-validated AND a valid from-email is set whose host matches
 * the authenticated domain. Any error (or any unmet condition) returns null so
 * callers fall back to the global verified sender and delivery never breaks.
 */
export async function resolveSellerSenderEmail(
  pubkey: string
): Promise<string | null> {
  if (!pubkey) return null;
  try {
    const row = await getByPubkey(pubkey);
    if (!row || !row.valid || !row.from_email || !row.domain) return null;
    const email = row.from_email.trim().toLowerCase();
    if (!isValidFromEmail(email, row.domain)) return null;
    return email;
  } catch (err) {
    console.error(
      "resolveSellerSenderEmail failed; falling back to default sender:",
      err
    );
    return null;
  }
}
