import type { NextApiRequest, NextApiResponse } from "next";
import { applyRateLimit } from "@/utils/rate-limit";
import { buildUcpDiscoveryProfile } from "@/utils/ucp/discovery";
import { deriveBaseUrl, resolveHostScope } from "@/utils/ucp/seller-host";

const RATE_LIMIT = { limit: 600, windowMs: 60 * 1000 };

/**
 * GET /.well-known/ucp — Universal Commerce Protocol discovery profile.
 *
 * Served (via proxy.ts) on the platform host AND on every seller custom domain /
 * self-host instance. The platform host returns an aggregate marketplace
 * profile; a seller host returns a profile scoped to that one seller.
 *
 * The host→seller binding (and its fail-closed security model) lives in
 * resolveHostScope; this handler only shapes the response. The profile only ever
 * exposes already-public catalog endpoints.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(204).end();
  }
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!applyRateLimit(req, res, "ucp-discovery", RATE_LIMIT)) return;

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");

  try {
    const baseUrl = deriveBaseUrl(req);
    const { seller, unresolved } = await resolveHostScope(req);

    // A seller host that resolves to nobody (unconfigured/hidden) advertises no
    // UCP profile.
    if (unresolved) {
      return res
        .status(404)
        .json({ error: "No UCP profile is configured for this domain." });
    }

    return res.status(200).json(buildUcpDiscoveryProfile({ baseUrl, seller }));
  } catch (error) {
    console.error("UCP discovery profile error:", error);
    return res
      .status(500)
      .json({ error: "Failed to build UCP discovery profile." });
  }
}
