import type { NextApiRequest, NextApiResponse } from "next";
import {
  getDbPool,
  fetchShopProfileByPubkeyFromDb,
} from "@/utils/db/db-service";
import { applyRateLimit } from "@/utils/rate-limit";
import { getMembershipView } from "@/utils/pro/membership";

const pool = getDbPool();

// Hit on every storefront page render (slug + custom-domain resolution).
// Generous to cover normal browsing; tight enough to bound a crawler.
const RATE_LIMIT = { limit: 600, windowMs: 60 * 1000 };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await applyRateLimit(req, res, "storefront-lookup", RATE_LIMIT)))
    return;

  // Mirror the service-worker's NetworkOnly rule for `/api/storefront/*`
  // at the HTTP layer too. Prevents intermediaries (browser HTTP cache,
  // CDNs, corp proxies) from caching a stale 404 from before the seller's
  // domain was verified or their slug was registered — which would
  // otherwise make a freshly-configured custom domain look permanently
  // misconfigured for the cache lifetime.
  res.setHeader("Cache-Control", "no-store, max-age=0");

  const { slug, domain, pubkey } = req.query;

  try {
    // Seed the seller's own stall settings form from the cached shop profile
    // event (kind 30019). Its content is public (published to relays / rendered
    // on the public storefront), so no auth is required. Returns the parsed
    // config the settings form hydrates from — or null for a brand-new seller.
    if (pubkey && typeof pubkey === "string") {
      const event = await fetchShopProfileByPubkeyFromDb(pubkey);
      if (!event) {
        return res.status(200).json({ shopConfig: null });
      }
      let shopConfig: unknown = null;
      try {
        shopConfig = JSON.parse(event.content);
      } catch {
        shopConfig = null;
      }
      return res.status(200).json({ shopConfig });
    }

    if (domain && typeof domain === "string") {
      const result = await pool.query(
        "SELECT pubkey, shop_slug, tls_status FROM custom_domains WHERE domain = $1 AND verified = true",
        [domain.toLowerCase()]
      );
      if (result.rows.length > 0) {
        // Custom domains are a Pro feature. Once a lapsed seller falls past the
        // read-only window (hidden), their custom domain stops resolving so the
        // proxy serves the unconfigured placeholder instead of the storefront.
        const view = await getMembershipView(result.rows[0].pubkey);
        if (view.isHidden) {
          return res.status(404).json({ error: "Domain not found" });
        }
        return res.status(200).json({
          pubkey: result.rows[0].pubkey,
          shopSlug: result.rows[0].shop_slug,
          // Consumed by the proxy's www.<domain> → bare-domain redirect, which
          // must not bounce buyers onto a domain whose certificate is still
          // pending/failed (mirrors resolveLiveSellerCustomDomainUrl's gate).
          // Additive: older proxies ignore it; older APIs omit it and the new
          // proxy treats a missing flag as not-yet-active (fails open to the
          // placeholder, never a redirect on a guess).
          tlsActive: result.rows[0].tls_status === "active",
        });
      }
      return res.status(404).json({ error: "Domain not found" });
    }

    if (slug && typeof slug === "string") {
      const result = await pool.query(
        "SELECT pubkey FROM shop_slugs WHERE slug = $1",
        [slug.toLowerCase()]
      );
      if (result.rows.length > 0) {
        return res.status(200).json({ pubkey: result.rows[0].pubkey });
      }
      return res.status(404).json({ error: "Stall not found" });
    }

    return res.status(400).json({ error: "slug or domain parameter required" });
  } catch (error) {
    console.error("Storefront lookup error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
