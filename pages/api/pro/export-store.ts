import type { NextApiRequest, NextApiResponse } from "next";
import { applyRateLimit } from "@/utils/rate-limit";
import {
  buildProExportStoreProof,
  extractSignedEventFromRequest,
  verifySignedHttpRequestProof,
} from "@/utils/nostr/request-auth";
import { getMembershipView } from "@/utils/pro/membership";
import { buildExportEntries } from "@/utils/self-host/export-bundle";
import { createZip } from "@/utils/self-host/zip";

// Produces a personalized self-host setup bundle (ZIP) for a Wrangler (lifetime)
// member. Two gates, both required:
//   1. The caller proves ownership of `pubkey` via a signed Nostr request proof
//      bound to this exact action/path.
//   2. That pubkey must be a LIFETIME (Wrangler) member — recurring Pro is not
//      enough; this is a Wrangler-only perk.
// The bundle contains ONLY the caller's own public config plus placeholder
// templates — never secrets, and never any other seller's data.
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (
    !(await applyRateLimit(req, res, "pro-export-store", {
      limit: 10,
      windowMs: 60_000,
    }))
  )
    return;

  const { pubkey, slug, relays, blossomServers, branding, upstreamRepo } =
    req.body || {};
  if (!pubkey || typeof pubkey !== "string") {
    return res.status(400).json({ error: "pubkey is required" });
  }

  const verification = verifySignedHttpRequestProof(
    extractSignedEventFromRequest(req),
    buildProExportStoreProof(pubkey)
  );
  if (!verification.ok) {
    return res.status(verification.status).json({ error: verification.error });
  }

  try {
    // Wrangler-only: recurring Pro members are rejected here.
    const view = await getMembershipView(pubkey);
    if (!view.isLifetime) {
      return res.status(403).json({
        error:
          "The self-host export is a Wrangler (lifetime) feature. Upgrade to Wrangler to download your store bundle.",
      });
    }

    const entries = buildExportEntries({
      pubkey,
      slug: typeof slug === "string" ? slug : null,
      relays,
      blossomServers,
      branding,
      upstreamRepo: typeof upstreamRepo === "string" ? upstreamRepo : null,
    });
    const zip = createZip(entries);

    const fileSlug =
      (typeof slug === "string" && slug.replace(/[^a-z0-9-]/gi, "")) ||
      pubkey.slice(0, 12);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="milk-market-self-host-${fileSlug}.zip"`
    );
    res.setHeader("Content-Length", String(zip.length));
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(zip);
  } catch (error) {
    console.error("pro export-store failed:", error);
    return res.status(500).json({
      error:
        error instanceof Error
          ? error.message
          : "Failed to build self-host export bundle",
    });
  }
}
