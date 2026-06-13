import { getSendGridApiKey } from "./sendgrid-client";

const SENDGRID_API_BASE = "https://api.sendgrid.com";

/** A single DNS record as returned by SendGrid's domain auth endpoints. */
export interface SendGridDnsRecord {
  valid?: boolean;
  type?: string;
  host?: string;
  data?: string;
}

/** Domain authentication object returned by create/get. */
export interface SendGridDomainAuth {
  id: number;
  domain: string;
  subdomain?: string;
  valid?: boolean;
  dns?: Record<string, SendGridDnsRecord>;
}

/** Result of POST /validate. */
export interface SendGridValidationResult {
  id: number;
  valid: boolean;
  validation_results?: Record<
    string,
    { valid?: boolean; reason?: string | null }
  >;
}

/** Normalized DNS record we store (JSONB) and surface to the seller's UI. */
export interface StoredDnsRecord {
  key: string;
  type: string;
  host: string;
  data: string;
  valid: boolean;
}

interface SgResponse {
  ok: boolean;
  status: number;
  data: any;
}

async function sgRequest(
  path: string,
  init?: RequestInit
): Promise<SgResponse> {
  const apiKey = await getSendGridApiKey();
  const res = await fetch(`${SENDGRID_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  let data: any = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { ok: res.ok, status: res.status, data };
}

/**
 * Build a human-readable error from a SendGrid error body without ever
 * surfacing the API key or raw request internals.
 */
function sgError(data: any, status: number): Error {
  if (data && typeof data === "object" && Array.isArray(data.errors)) {
    const msg = data.errors
      .map((e: any) => e?.message)
      .filter(Boolean)
      .join("; ");
    if (msg) return new Error(msg);
  }
  return new Error(`SendGrid request failed (status ${status})`);
}

/**
 * Authenticate a domain with automatic security (SendGrid manages SPF/DKIM,
 * yielding 3 CNAME records the seller adds to their DNS).
 * POST /v3/whitelabel/domains
 */
export async function createDomainAuthentication(
  domain: string
): Promise<SendGridDomainAuth> {
  const { ok, status, data } = await sgRequest("/v3/whitelabel/domains", {
    method: "POST",
    body: JSON.stringify({ domain, automatic_security: true }),
  });
  if (!ok) throw sgError(data, status);
  return data as SendGridDomainAuth;
}

/**
 * Validate an authenticated domain (checks the seller added the DNS records).
 * POST /v3/whitelabel/domains/{id}/validate
 */
export async function validateDomainAuthentication(
  id: number
): Promise<SendGridValidationResult> {
  const { ok, status, data } = await sgRequest(
    `/v3/whitelabel/domains/${id}/validate`,
    { method: "POST" }
  );
  if (!ok) throw sgError(data, status);
  return data as SendGridValidationResult;
}

/**
 * Retrieve an authenticated domain (used to refresh DNS record valid flags).
 * GET /v3/whitelabel/domains/{id}
 */
export async function getDomainAuthentication(
  id: number
): Promise<SendGridDomainAuth> {
  const { ok, status, data } = await sgRequest(`/v3/whitelabel/domains/${id}`, {
    method: "GET",
  });
  if (!ok) throw sgError(data, status);
  return data as SendGridDomainAuth;
}

/**
 * Delete an authenticated domain. Treats a 404 as already-gone so disconnect
 * is idempotent. DELETE /v3/whitelabel/domains/{id}
 */
export async function deleteDomainAuthentication(id: number): Promise<void> {
  const { ok, status, data } = await sgRequest(`/v3/whitelabel/domains/${id}`, {
    method: "DELETE",
  });
  if (!ok && status !== 404) throw sgError(data, status);
}

/** Convert SendGrid's `dns` map into a stable, display-friendly list. */
export function toDnsRecordList(
  dns: Record<string, SendGridDnsRecord> | undefined | null
): StoredDnsRecord[] {
  if (!dns || typeof dns !== "object") return [];
  return Object.entries(dns).map(([key, rec]) => ({
    key,
    type: (rec?.type || "CNAME").toUpperCase(),
    host: rec?.host || "",
    data: rec?.data || "",
    valid: !!rec?.valid,
  }));
}
