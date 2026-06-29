import type { NextApiRequest, NextApiResponse } from "next";
import { verifyNostrAuth } from "@/utils/stripe/verify-nostr-auth";
import { checkRateLimit, getRequestIp } from "@/utils/rate-limit";
import { requireProEntitlement } from "@/utils/pro/require-pro";
import { isValidDomain } from "@/utils/db/custom-domains";
import {
  deleteByPubkey,
  getByDomain,
  getByPubkey,
  isValidFromEmail,
  setFromEmail,
  upsertPending,
  type EmailSenderDomainRow,
} from "@/utils/db/email-sender-domains";
import {
  createDomainAuthentication,
  deleteDomainAuthentication,
  toDnsRecordList,
} from "@/utils/email/sendgrid-domain-auth";

const RATE_LIMIT = { limit: 20, windowMs: 60 * 1000 };
const AUTH_PATH = "/api/email/sender-domain";

function publicView(row: EmailSenderDomainRow) {
  return {
    domain: row.domain,
    valid: row.valid,
    fromEmail: row.from_email,
    subdomain: row.subdomain,
    dnsRecords: row.dns_records ?? [],
    createdAt: row.created_at,
    lastValidationAt: row.last_validation_at,
  };
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (
    req.method === "POST" ||
    req.method === "PUT" ||
    req.method === "DELETE"
  ) {
    const rate = await checkRateLimit(
      "email-sender-domain",
      getRequestIp(req),
      RATE_LIMIT
    );
    res.setHeader("X-RateLimit-Limit", String(rate.limit));
    res.setHeader("X-RateLimit-Remaining", String(rate.remaining));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(rate.resetAt / 1000)));
    if (!rate.ok) {
      res.setHeader(
        "Retry-After",
        String(Math.max(0, Math.ceil((rate.resetAt - Date.now()) / 1000)))
      );
      return res.status(429).json({ error: "Too many requests" });
    }
  }

  // --- Connect a domain (Pro-gated) -----------------------------------------
  if (req.method === "POST") {
    const { pubkey, domain, signedEvent } = req.body ?? {};
    if (!pubkey || !domain) {
      return res.status(400).json({ error: "pubkey and domain are required" });
    }
    if (!signedEvent) {
      return res.status(400).json({ error: "signedEvent is required" });
    }

    const cleanDomain = String(domain).toLowerCase().trim();
    if (!isValidDomain(cleanDomain)) {
      return res.status(400).json({ error: "Invalid domain format" });
    }

    const authResult = verifyNostrAuth(
      signedEvent,
      pubkey,
      "email-sender-domain-write" as any,
      {
        method: "POST",
        path: AUTH_PATH,
        fields: { domain: cleanDomain },
      } as any
    );
    if (!authResult.valid) {
      return res
        .status(401)
        .json({ error: authResult.error || "Authentication failed" });
    }

    if (!(await requireProEntitlement(pubkey, res))) return;

    try {
      // Domains are globally unique (single platform SendGrid account).
      const existingForDomain = await getByDomain(cleanDomain);
      if (existingForDomain && existingForDomain.pubkey !== pubkey) {
        return res.status(409).json({
          error: "This domain is already connected by another account",
        });
      }

      const existingForPubkey = await getByPubkey(pubkey);
      // Idempotent re-submit of the same domain: return current state instead
      // of creating a duplicate authentication on SendGrid.
      if (
        existingForPubkey &&
        existingForPubkey.domain === cleanDomain &&
        existingForPubkey.sendgrid_domain_id
      ) {
        return res.status(200).json(publicView(existingForPubkey));
      }
      // Switching domains: best-effort clean up the old SendGrid entry so we
      // don't leave an orphaned authentication on the platform account.
      if (
        existingForPubkey &&
        existingForPubkey.sendgrid_domain_id &&
        existingForPubkey.domain !== cleanDomain
      ) {
        try {
          await deleteDomainAuthentication(
            existingForPubkey.sendgrid_domain_id
          );
        } catch (e) {
          console.error("Failed to delete previous SendGrid domain:", e);
        }
      }

      const sg = await createDomainAuthentication(cleanDomain);
      const dnsRecords = toDnsRecordList(sg.dns);
      const row = await upsertPending({
        pubkey,
        domain: cleanDomain,
        sendgridDomainId: sg.id,
        subdomain: sg.subdomain ?? null,
        dnsRecords,
        valid: !!sg.valid,
      });
      return res.status(200).json(publicView(row));
    } catch (error: any) {
      if (error?.code === "23505") {
        return res
          .status(409)
          .json({ error: "This domain is already connected" });
      }
      console.error("Email sender domain error:", error);
      return res
        .status(500)
        .json({ error: error?.message || "Internal server error" });
    }
  }

  // --- Read current status ---------------------------------------------------
  if (req.method === "GET") {
    const { pubkey } = req.query;
    if (!pubkey || typeof pubkey !== "string") {
      return res.status(400).json({ error: "pubkey parameter required" });
    }
    try {
      const row = await getByPubkey(pubkey);
      if (!row) return res.status(200).json(null);
      return res.status(200).json(publicView(row));
    } catch (error) {
      console.error("Email sender domain lookup error:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  // --- Set the from-address (Pro-gated) -------------------------------------
  if (req.method === "PUT") {
    const { pubkey, fromEmail, signedEvent } = req.body ?? {};
    if (!pubkey || !fromEmail) {
      return res
        .status(400)
        .json({ error: "pubkey and fromEmail are required" });
    }
    if (!signedEvent) {
      return res.status(400).json({ error: "signedEvent is required" });
    }

    const authResult = verifyNostrAuth(
      signedEvent,
      pubkey,
      "email-sender-domain-write" as any,
      { method: "PUT", path: AUTH_PATH } as any
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
      if (!row.valid) {
        return res.status(400).json({
          error: "Verify your domain before choosing a sending address",
        });
      }
      const cleanFrom = String(fromEmail).toLowerCase().trim();
      if (!isValidFromEmail(cleanFrom, row.domain)) {
        return res
          .status(400)
          .json({ error: `Your sending address must end with @${row.domain}` });
      }
      await setFromEmail(pubkey, cleanFrom);
      const updated = await getByPubkey(pubkey);
      return res.status(200).json(updated ? publicView(updated) : null);
    } catch (error) {
      console.error("Email sender from-email error:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  // --- Disconnect (auth-only, so lapsed sellers can always detach) ----------
  if (req.method === "DELETE") {
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
      { method: "DELETE", path: AUTH_PATH } as any
    );
    if (!authResult.valid) {
      return res
        .status(401)
        .json({ error: authResult.error || "Authentication failed" });
    }

    try {
      const row = await getByPubkey(pubkey);
      if (row?.sendgrid_domain_id) {
        try {
          await deleteDomainAuthentication(row.sendgrid_domain_id);
        } catch (e) {
          console.error("Failed to delete SendGrid domain on disconnect:", e);
        }
      }
      await deleteByPubkey(pubkey);
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error("Email sender domain delete error:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
