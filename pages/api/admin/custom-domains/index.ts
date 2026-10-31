import type { NextApiRequest, NextApiResponse } from "next";
import { applyRateLimit } from "@/utils/rate-limit";
import { listDomains } from "@/utils/db/custom-domains";
import { isAdminPubkey } from "@/utils/admin/auth";
import { verifyNostrAuth } from "@/utils/stripe/verify-nostr-auth";
import { checkWwwVariantHealth } from "@/utils/custom-domain-www-health";
import {
  advanceCustomDomainStatus,
  WWW_CNAME_TARGET,
} from "@/utils/custom-domain-lifecycle";

const RATE_LIMIT = { limit: 60, windowMs: 60 * 1000 };

const ALLOWED_STATUSES = [
  "pending_dns",
  "dns_verified",
  "attached",
  "active",
  "failed",
  "needs_attach",
];

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (!(await applyRateLimit(req, res, "admin-custom-domains", RATE_LIMIT)))
    return;

  const filter = typeof req.query.status === "string" ? req.query.status : "";

  // Authorization: either
  //   (a) server-to-server bearer secret, OR
  //   (b) signed Nostr event from an admin pubkey, sent either as POST body
  //       or as `?signedEvent=<json>` query param for the GET admin page.
  const headerSecret = req.headers["x-admin-secret"];
  const envSecret = process.env.ADMIN_API_SECRET;

  if (envSecret && headerSecret === envSecret) {
    // ok — server-to-server
  } else {
    let signedEvent: any = null;
    if (req.method === "POST") {
      signedEvent = req.body?.signedEvent ?? null;
    } else if (typeof req.query.signedEvent === "string") {
      try {
        signedEvent = JSON.parse(req.query.signedEvent);
      } catch {
        signedEvent = null;
      }
    }

    if (!signedEvent) {
      return res.status(401).json({ error: "Admin authentication required" });
    }

    const result = verifyNostrAuth(
      signedEvent,
      undefined,
      "admin-domain-list" as any,
      {
        method: req.method as any,
        path: "/api/admin/custom-domains",
      } as any
    );
    if (!result.valid) {
      return res
        .status(401)
        .json({ error: result.error || "Invalid admin auth" });
    }
    if (!isAdminPubkey(result.pubkey)) {
      return res.status(403).json({ error: "Not an admin" });
    }
  }

  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const rows = await listDomains(
    ALLOWED_STATUSES.includes(filter) ? { status: filter as any } : undefined
  );

  // Auto-advance lifecycle statuses before reporting, so the panel converges
  // on the true state without manual toggling: pending_dns rows whose DNS
  // now verifies flip to dns_verified, and verified rows whose TLS
  // certificate is already live flip to active. Forward-only — DNS/probe
  // failures leave the row untouched, and the dropdown stays as the manual
  // override when automation gets it wrong.
  const domains = await Promise.all(
    rows.map(async (r) => {
      const adv = await advanceCustomDomainStatus(r);
      return adv.changed
        ? { ...r, verified: adv.verified, tls_status: adv.to }
        : r;
    })
  );

  // Live www health check for verified apex domains so the admin panel
  // tracks "www attached" state itself instead of relying on the admin
  // remembering to attach the www variant (and remembering to record that
  // they did). DNS is checked BEFORE the TLS probe: apex verification says
  // nothing about www, and a registrar parking page serves perfectly valid
  // HTTPS — probing without the DNS check would paint a parked www host
  // green while buyers never reach the storefront. Only apex domains have a
  // www variant buyers type; unverified or pre-DNS rows are skipped —
  // nothing should be attached for those yet.
  const wwwHealth = await Promise.all(
    domains.map(async (r) => {
      if (
        r.domain_type !== "apex" ||
        !r.verified ||
        !["dns_verified", "attached", "active"].includes(r.tls_status)
      ) {
        return null;
      }
      const health = await checkWwwVariantHealth(r.domain);
      return health ? { ok: health.state === "ok", state: health.state } : null;
    })
  );

  return res.status(200).json({
    // The CNAME target a seller points "www" at, surfaced so the panel can
    // show the exact record value when a www variant is missing.
    wwwCnameTarget: WWW_CNAME_TARGET,
    domains: domains.map((r, i) => ({
      domain: r.domain,
      pubkey: r.pubkey,
      shopSlug: r.shop_slug,
      verified: r.verified,
      domainType: r.domain_type,
      tlsStatus: r.tls_status,
      verificationToken: r.verification_token,
      attachedAt: r.attached_at,
      adminNotifiedAt: r.admin_notified_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      wwwTls: wwwHealth[i] ?? null,
    })),
  });
}
