import type { NextApiRequest, NextApiResponse } from "next";
import { applyRateLimit } from "@/utils/rate-limit";
import { verifyNostrAuth } from "@/utils/stripe/verify-nostr-auth";
import { requireProEntitlement } from "@/utils/pro/require-pro";
import { getByPubkey, markValidated } from "@/utils/db/email-sender-domains";
import {
  getDomainAuthentication,
  toDnsRecordList,
  validateDomainAuthentication,
} from "@/utils/email/sendgrid-domain-auth";

const RATE_LIMIT = { limit: 15, windowMs: 60 * 1000 };
const AUTH_PATH = "/api/email/verify-sender-domain";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!applyRateLimit(req, res, "verify-sender-domain", RATE_LIMIT)) return;

  const { pubkey, signedEvent } = req.body ?? {};
  if (!pubkey) {
    return res.status(400).json({ error: "pubkey is required" });
  }
  if (!signedEvent) {
    return res.status(400).json({ error: "signedEvent is required" });
  }

  const authResult = verifyNostrAuth(
    signedEvent,
    pubkey,
    "email-sender-domain-write" as any,
    { method: "POST", path: AUTH_PATH } as any
  );
  if (!authResult.valid) {
    return res
      .status(401)
      .json({ error: authResult.error || "Authentication failed" });
  }

  if (!(await requireProEntitlement(pubkey, res))) return;

  try {
    const row = await getByPubkey(pubkey);
    if (!row) {
      return res.status(404).json({ error: "No sending domain found" });
    }
    if (!row.sendgrid_domain_id) {
      return res.status(400).json({ error: "Connect a domain first" });
    }

    const result = await validateDomainAuthentication(row.sendgrid_domain_id);
    const valid = !!result.valid;

    // Refresh stored DNS records so the UI can show which records are still
    // missing. Best-effort — the validate call already told us the result.
    let dnsRecords = row.dns_records ?? [];
    try {
      const fresh = await getDomainAuthentication(row.sendgrid_domain_id);
      dnsRecords = toDnsRecordList(fresh.dns);
    } catch (e) {
      console.error("Failed to refresh SendGrid DNS records:", e);
    }

    await markValidated(pubkey, valid, dnsRecords);

    const message = valid
      ? "Your domain is verified! You can now send emails from it."
      : "We couldn't verify all DNS records yet. DNS changes can take up to 48 hours to take effect.";

    return res.status(200).json({
      valid,
      dnsRecords,
      validationResults: result.validation_results ?? null,
      message,
    });
  } catch (error: any) {
    console.error("Email sender domain verification error:", error);
    return res
      .status(500)
      .json({ error: error?.message || "Verification failed" });
  }
}
