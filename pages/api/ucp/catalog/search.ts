import type { NextApiRequest, NextApiResponse } from "next";
import { nip19 } from "nostr-tools";
import {
  fetchAllProductsFromDb,
  fetchProductsByPubkeyFromDb,
} from "@/utils/db/db-service";
import { applyRateLimit } from "@/utils/rate-limit";
import { buildUcpCatalog } from "@/utils/ucp/catalog";
import type { UcpProduct } from "@/utils/ucp/types";
import {
  deriveBaseUrl,
  fetchSellerNames,
  resolveHostScope,
} from "@/utils/ucp/seller-host";

export const config = { api: { responseLimit: false } };

const RATE_LIMIT = { limit: 600, windowMs: 60 * 1000 };

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
// Cap on how many listings we map before filtering. Mirrors the MCP catalog
// resource so friendly-slug disambiguation sees a seller's full set.
const SCAN_CAP = 1000;

/**
 * GET /api/ucp/catalog/search — Universal Commerce Protocol catalog search.
 *
 * Host-scoped: on a seller's custom domain / self-host instance the results are
 * limited to that one seller (resolved + membership-gated from the verified host
 * by resolveHostScope, never a forgeable header). On the platform host it
 * searches the whole marketplace, optionally narrowed by a `seller` pubkey.
 *
 * All catalog data is already public; the response shape is the shared UCP
 * product representation (utils/ucp/catalog.ts) so MCP + UCP can't drift.
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
  if (!(await applyRateLimit(req, res, "ucp-catalog-search", RATE_LIMIT)))
    return;

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");

  try {
    const baseUrl = deriveBaseUrl(req);
    const { scope, seller, unresolved } = await resolveHostScope(req);

    // A seller host that resolves to nobody serves no catalog.
    if (unresolved) {
      return res
        .status(404)
        .json({ error: "No catalog is configured for this domain." });
    }

    const q = str(req.query.q) || str(req.query.query);
    const category = str(req.query.category) || str(req.query.t);
    const availability = str(req.query.availability);
    const location = str(req.query.location);
    const limit = clampInt(req.query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);

    // Scope decides the seller filter: a seller host is locked to its owner; the
    // platform host may optionally narrow by a supplied seller pubkey/npub.
    let sellerPubkey = seller?.pubkey || null;
    if (!sellerPubkey) {
      const requested = str(req.query.seller) || str(req.query.pubkey);
      if (requested) sellerPubkey = decodePubkey(requested);
    }

    const events = sellerPubkey
      ? await fetchProductsByPubkeyFromDb(sellerPubkey, SCAN_CAP, 0)
      : await fetchAllProductsFromDb(SCAN_CAP, 0);

    const sellerOrigin = scope === "seller" ? baseUrl : undefined;
    const platformUrl =
      process.env.NEXT_PUBLIC_BASE_URL || "https://milk.market";

    let products = buildUcpCatalog(events, { platformUrl, sellerOrigin });

    if (q) {
      const needle = q.toLowerCase();
      products = products.filter((p) => matchesText(p, needle));
    }
    if (category) {
      const cat = category.toLowerCase();
      products = products.filter((p) =>
        (p.categories || []).some((c) => c.toLowerCase() === cat)
      );
    }
    if (availability === "in_stock" || availability === "out_of_stock") {
      products = products.filter((p) => p.availability === availability);
    }
    if (location) {
      const loc = location.toLowerCase();
      products = products.filter((p) =>
        (p.location || "").toLowerCase().includes(loc)
      );
    }

    const total = products.length;
    const page = products.slice(offset, offset + limit);

    // Enrich only the page with seller display names (bounded by page size).
    const names = await fetchSellerNames(page.map((p) => p.seller.pubkey));
    for (const p of page) {
      const name = names.get(p.seller.pubkey);
      if (name) p.seller.name = name;
    }

    return res.status(200).json({
      products: page,
      context: {
        scope,
        ...(seller
          ? {
              seller: {
                pubkey: seller.pubkey,
                npub: seller.npub,
                ...(seller.name ? { name: seller.name } : {}),
              },
            }
          : {}),
        query: {
          ...(q ? { q } : {}),
          ...(category ? { category } : {}),
          ...(availability ? { availability } : {}),
          ...(location ? { location } : {}),
          ...(sellerPubkey && scope !== "seller"
            ? { seller: sellerPubkey }
            : {}),
        },
        pagination: {
          limit,
          offset,
          returned: page.length,
          total,
          hasMore: offset + page.length < total,
        },
        links: {
          self: `${baseUrl}/api/ucp/catalog/search`,
          lookup: `${baseUrl}/api/ucp/catalog/lookup`,
          discovery: `${baseUrl}/.well-known/ucp`,
        },
      },
    });
  } catch (error) {
    console.error("UCP catalog search error:", error);
    return res.status(500).json({ error: "Failed to search catalog." });
  }
}

function matchesText(p: UcpProduct, needle: string): boolean {
  if (p.title.toLowerCase().includes(needle)) return true;
  if ((p.description || "").toLowerCase().includes(needle)) return true;
  return (p.categories || []).some((c) => c.toLowerCase().includes(needle));
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function clampInt(v: unknown, dflt: number, min: number, max: number): number {
  const n = parseInt(typeof v === "string" ? v : "", 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(n, min), max);
}

/** Accept either a hex pubkey or a bech32 npub; returns hex (lowercased). */
function decodePubkey(value: string): string | null {
  const v = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(v)) return v.toLowerCase();
  try {
    const decoded = nip19.decode(v);
    if (decoded.type === "npub" && typeof decoded.data === "string") {
      return decoded.data.toLowerCase();
    }
  } catch {
    // fall through
  }
  return null;
}
