import type { NextApiRequest, NextApiResponse } from "next";
import {
  fetchShopPubkeyBySlug,
  fetchShopProfileByPubkeyFromDb,
  fetchProfileByPubkeyFromDb,
  fetchAllProductsFromDb,
} from "@/utils/db/db-service";
import { resolveStallBranding } from "@/utils/storefront/stall-branding";
import parseTags, {
  ProductData,
} from "@/utils/parsers/product-parser-functions";
import { getListingSlug } from "@/utils/url-slugs";
import { applyRateLimit } from "@/utils/rate-limit";
import { sendAgentError } from "@/utils/api/agent-error";
import {
  buildStallMarkdown,
  buildStallJson,
  buildStallText,
  buildStallLlmsTxt,
  buildStallRobotsTxt,
  buildStallSitemap,
  buildStallRss,
  type StallContentInput,
  type StallProductSummary,
} from "@/utils/geo/stall-content";

// Backing endpoint for per-stall content negotiation. `proxy.ts` rewrites a
// seller's custom domain (and platform /stall/<slug>) requests here, passing
// the resolved slug, requested format, and canonical site URL through request
// headers (query string is a fallback for direct calls). Returns shop-specific
// markdown / JSON / plain-text / llms.txt / robots.txt / RSS so LLMs and agents
// get tailored, machine-readable storefront content while browsers and SEO bots
// keep getting HTML.

const PLATFORM = "https://milk.market";

const RATE_LIMIT = { limit: 600, windowMs: 60 * 1000 };

type Format = "md" | "json" | "txt" | "llms" | "robots" | "sitemap" | "rss";

function headerStr(req: NextApiRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function queryStr(req: NextApiRequest, name: string): string | undefined {
  const v = req.query[name];
  return Array.isArray(v) ? v[0] : v;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const slug = headerStr(req, "x-stall-slug") || queryStr(req, "slug") || "";
  const format = (headerStr(req, "x-stall-format") ||
    queryStr(req, "format") ||
    "md") as Format;
  const host = headerStr(req, "x-mm-custom-domain-host");
  const isCustomDomain = !!host;
  const siteUrl = host ? `https://${host}` : `${PLATFORM}/stall/${slug}`;

  res.setHeader("Vary", "Accept, User-Agent");
  res.setHeader("Cache-Control", "public, max-age=600, s-maxage=600");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("X-Robots-Tag", "noindex");

  if (!applyRateLimit(req, res, "stall-agent-view", RATE_LIMIT)) return;

  if (!slug) {
    return sendAgentError(res, {
      status: 400,
      error: "Missing stall slug",
      code: "missing_slug",
      message: "A stall slug is required to render machine-readable content.",
    });
  }

  try {
    const pubkey = await fetchShopPubkeyBySlug(slug);
    if (!pubkey) {
      return sendAgentError(res, {
        status: 404,
        error: "Shop not found",
        code: "not_found",
        message: `No shop matches the slug "${slug}".`,
        slug,
      });
    }

    const [shopEvent, profileEvent, allProducts] = await Promise.all([
      fetchShopProfileByPubkeyFromDb(pubkey),
      fetchProfileByPubkeyFromDb(pubkey),
      fetchAllProductsFromDb(500, 0),
    ]);

    let shopContent: Record<string, unknown> | null = null;
    if (shopEvent) {
      try {
        shopContent = JSON.parse(shopEvent.content);
      } catch {
        shopContent = null;
      }
    }
    let profileContent: Record<string, unknown> | null = null;
    if (profileEvent) {
      try {
        profileContent = JSON.parse(profileEvent.content);
      } catch {
        profileContent = null;
      }
    }

    const branding = resolveStallBranding(shopContent, profileContent);

    const sellerEvents = allProducts.filter((e) => e.pubkey === pubkey);
    const sellerParsed = sellerEvents
      .map((event) => ({ event, data: parseTags(event) }))
      .filter(
        (
          entry
        ): entry is {
          event: (typeof sellerEvents)[number];
          data: ProductData;
        } => !!entry.data
      );
    const allSellerData = sellerParsed.map((e) => e.data);

    const products: StallProductSummary[] = sellerParsed
      .slice(0, 50)
      .map(({ event, data }) => ({
        title: data.title || "Untitled listing",
        slug: getListingSlug(data, allSellerData) || event.id,
        price: data.price ?? null,
        currency: data.currency || "sats",
        summary: data.summary || "",
        image: data.images?.[0] || "",
      }));

    const input: StallContentInput = {
      shopName: branding.shopName,
      about: branding.about,
      image: branding.image,
      slug,
      siteUrl,
      isCustomDomain,
      products,
    };

    switch (format) {
      case "json":
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        return res.status(200).json(buildStallJson(input));
      case "txt":
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        return res.status(200).send(buildStallText(input));
      case "llms":
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        return res.status(200).send(buildStallLlmsTxt(input));
      case "robots":
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        return res.status(200).send(buildStallRobotsTxt(input));
      case "sitemap":
        res.setHeader("Content-Type", "application/xml; charset=utf-8");
        return res.status(200).send(buildStallSitemap(input));
      case "rss":
        res.setHeader("Content-Type", "application/rss+xml; charset=utf-8");
        return res.status(200).send(buildStallRss(input));
      case "md":
      default:
        res.setHeader("Content-Type", "text/markdown; charset=utf-8");
        return res.status(200).send(buildStallMarkdown(input));
    }
  } catch (error) {
    console.error("stall-agent-view failed:", error);
    return sendAgentError(res, {
      status: 500,
      error: "Failed to render stall content",
      code: "stall_render_error",
      slug,
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
