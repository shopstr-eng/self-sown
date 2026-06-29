import type { NextApiRequest, NextApiResponse } from "next";
import { nip19 } from "nostr-tools";
import {
  fetchProductByIdFromDb,
  fetchProductsByPubkeyFromDb,
} from "@/utils/db/db-service";
import { getAllStock } from "@/utils/db/inventory-service";
import { applyRateLimit } from "@/utils/rate-limit";
import { eventToUcpProduct } from "@/utils/ucp/catalog";
import { getListingSlug, type ListingSlugCandidate } from "@/utils/url-slugs";
import type { NostrEvent } from "@/utils/types/types";
import {
  deriveBaseUrl,
  fetchSellerNames,
  resolveHostScope,
  resolveSellerPaymentMethods,
} from "@/utils/ucp/seller-host";

const RATE_LIMIT = { limit: 600, windowMs: 60 * 1000 };

/**
 * GET /api/ucp/catalog/lookup — resolve a single product to the shared UCP
 * shape, with a live inventory snapshot and the seller's accepted payment
 * methods.
 *
 * Resolution accepts one of: `id` (event id), or `d` + `pubkey` (NIP-99
 * address), or `slug` + `pubkey`. On a seller host the resolved product must
 * belong to that seller (else 404); the host→seller binding is the same
 * fail-closed resolution shared with discovery + search.
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
  if (!(await applyRateLimit(req, res, "ucp-catalog-lookup", RATE_LIMIT)))
    return;

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");

  try {
    const baseUrl = deriveBaseUrl(req);
    const { scope, seller, unresolved } = await resolveHostScope(req);
    if (unresolved) {
      return res
        .status(404)
        .json({ error: "No catalog is configured for this domain." });
    }

    const id = str(req.query.id) || str(req.query.event_id);
    const dTag = str(req.query.d) || str(req.query.d_tag);
    const slug = str(req.query.slug);

    // A seller host pins the pubkey to its owner; otherwise it comes from query.
    const queryPubkey = decodePubkey(
      str(req.query.pubkey) || str(req.query.seller)
    );
    const scopedPubkey = seller?.pubkey || queryPubkey;

    const event = await resolveEvent({ id, dTag, slug, pubkey: scopedPubkey });
    if (!event) {
      return res.status(404).json({ error: "Product not found." });
    }

    // On a seller host, never serve another seller's product.
    if (seller && event.pubkey.toLowerCase() !== seller.pubkey.toLowerCase()) {
      return res.status(404).json({ error: "Product not found." });
    }

    // Compute the friendly slug against the seller's full set so the canonical
    // URL matches the storefront, then attach live inventory + payment methods.
    const sellerEvents = await fetchProductsByPubkeyFromDb(
      event.pubkey,
      1000,
      0
    );
    const candidates: ListingSlugCandidate[] = sellerEvents.map((ev) => ({
      id: ev.id,
      title: tagValue(ev, "title"),
      pubkey: ev.pubkey,
    }));
    const self = candidates.find((c) => c.id === event.id) || {
      id: event.id,
      title: tagValue(event, "title"),
      pubkey: event.pubkey,
    };
    const listingSlug = getListingSlug(self, candidates);

    const [inventory, paymentMethods, names] = await Promise.all([
      getAllStock(event.id).catch(() => null),
      resolveSellerPaymentMethods(event.pubkey),
      fetchSellerNames([event.pubkey]),
    ]);

    const sellerOrigin = scope === "seller" ? baseUrl : undefined;
    const platformUrl =
      process.env.NEXT_PUBLIC_BASE_URL || "https://milk.market";

    const product = eventToUcpProduct(event, {
      platformUrl,
      sellerOrigin,
      listingSlug,
      inventory,
      paymentMethods,
      sellerName: seller?.name || names.get(event.pubkey),
    });

    return res.status(200).json({
      product,
      context: {
        scope,
        links: {
          self: `${baseUrl}/api/ucp/catalog/lookup`,
          search: `${baseUrl}/api/ucp/catalog/search`,
          discovery: `${baseUrl}/.well-known/ucp`,
        },
      },
    });
  } catch (error) {
    console.error("UCP catalog lookup error:", error);
    return res.status(500).json({ error: "Failed to look up product." });
  }
}

async function resolveEvent(args: {
  id: string;
  dTag: string;
  slug: string;
  pubkey: string | null;
}): Promise<NostrEvent | null> {
  const { id, dTag, slug, pubkey } = args;

  // 1) Direct event id — unambiguous.
  if (id) return fetchProductByIdFromDb(id);

  // 2) d-tag or slug require a seller pubkey to disambiguate across the market.
  if (!pubkey) return null;
  if (!dTag && !slug) return null;

  const sellerEvents = await fetchProductsByPubkeyFromDb(pubkey, 1000, 0);
  if (sellerEvents.length === 0) return null;

  if (dTag) {
    const byDTag = sellerEvents.find((ev) => tagValue(ev, "d") === dTag);
    if (byDTag) return byDTag;
  }

  if (slug) {
    const candidates: ListingSlugCandidate[] = sellerEvents.map((ev) => ({
      id: ev.id,
      title: tagValue(ev, "title"),
      pubkey: ev.pubkey,
    }));
    const match = sellerEvents.find((ev) => {
      const cand = candidates.find((c) => c.id === ev.id)!;
      return getListingSlug(cand, candidates) === slug;
    });
    if (match) return match;
    // Fall back to a bare d-tag match against the slug.
    const byDTag = sellerEvents.find((ev) => tagValue(ev, "d") === slug);
    if (byDTag) return byDTag;
  }

  return null;
}

function tagValue(event: NostrEvent, key: string): string {
  const tag = (event.tags || []).find((t) => t[0] === key);
  return tag ? tag[1] || "" : "";
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function decodePubkey(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
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
