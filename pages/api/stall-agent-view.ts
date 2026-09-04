import type { NextApiRequest, NextApiResponse } from "next";
import {
  fetchShopPubkeyBySlug,
  fetchShopProfileByPubkeyFromDb,
  fetchProfileByPubkeyFromDb,
  fetchProductsByPubkeyFromDb,
  fetchBlogPostsByPubkeyFromDb,
} from "@/utils/db/db-service";
import { resolveStallBranding } from "@/utils/storefront/stall-branding";
import parseTags, {
  ProductData,
} from "@/utils/parsers/product-parser-functions";
import {
  getListingSlug,
  getBlogPostSlug,
  findBlogPostBySlug,
} from "@/utils/url-slugs";
import { parseBlogPostEvent, type BlogPost } from "@milk-market/domain";
import { applyRateLimit } from "@/utils/rate-limit";
import {
  sendAgentError,
  acceptsMarkdown,
  buildAgentNotFoundMarkdown,
  buildAgentProRequiredMarkdown,
} from "@/utils/api/agent-error";
import { getMembershipView } from "@/utils/pro/membership";
import {
  buildStallMarkdown,
  buildStallJson,
  buildStallText,
  buildStallLlmsTxt,
  buildStallRobotsTxt,
  buildStallSitemap,
  buildStallRss,
  buildPostMarkdown,
  buildPostJson,
  buildPostText,
  buildPostLlmsTxt,
  type StallContentInput,
  type StallProductSummary,
  type StallBlogSummary,
  type StallPostInput,
} from "@/utils/geo/stall-content";

// Backing endpoint for per-stall content negotiation. `proxy.ts` rewrites a
// seller's custom domain (and platform /stall/<slug>) requests here, passing
// the resolved slug, requested format, and canonical site URL through request
// headers (query string is a fallback for direct calls). Returns shop-specific
// markdown / JSON / plain-text / llms.txt / robots.txt / RSS so LLMs and agents
// get tailored, machine-readable storefront content while browsers and SEO bots
// keep getting HTML. When `x-post-slug` (or ?postSlug) is set, it instead
// renders a single blog post's full article body (markdown / JSON / plain-text /
// llms) for /blog/<slug> content negotiation.

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
  // When set, render a single blog post (full body) instead of the stall view.
  const postSlug =
    headerStr(req, "x-post-slug") || queryStr(req, "postSlug") || "";
  const host = headerStr(req, "x-mm-custom-domain-host");
  const isCustomDomain = !!host;
  const siteUrl = host ? `https://${host}` : `${PLATFORM}/stall/${slug}`;

  res.setHeader("Vary", "Accept, User-Agent");
  // Entitlement-gated content: never shared-cacheable. A public max-age could
  // keep serving a seller's machine-readable content for minutes AFTER their
  // Pro membership lapses (or hold a 403 against a seller who just renewed).
  // Representation identity also comes from request headers (x-stall-slug /
  // x-stall-format / x-post-slug), which Vary cannot safely key on here.
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("X-Robots-Tag", "noindex");

  if (!(await applyRateLimit(req, res, "stall-agent-view", RATE_LIMIT))) return;

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
      // Content-negotiated 404: markdown for agents that ask for it (parity
      // with the site-wide catch-all), structured JSON otherwise.
      if (acceptsMarkdown(req)) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/markdown; charset=utf-8");
        return res.end(
          buildAgentNotFoundMarkdown(
            siteUrl,
            `No shop matches the slug "${slug}".`
          )
        );
      }
      return sendAgentError(res, {
        status: 404,
        error: "Shop not found",
        code: "not_found",
        message: `No shop matches the slug "${slug}".`,
        slug,
      });
    }

    // Machine-readable stall/blog content is a Pro feature, mirroring the HTML
    // page which gates OG meta/JSON-LD on membership.isPro. Lapsed sellers
    // (read-only/hidden) get a fail-closed 403 — agents never see premium
    // machine-readable content without an active membership. getMembershipView
    // throws on DB outage (500 via the catch below, never a silent 403), and
    // self-host tenants resolve as lifetime members inside getMembershipView.
    // Checked BEFORE the heavy product/blog fetches so a lapsed seller's view
    // costs one membership row read and leaks nothing.
    const membership = await getMembershipView(pubkey);
    if (!membership.isPro) {
      if (acceptsMarkdown(req)) {
        res.statusCode = 403;
        res.setHeader("Content-Type", "text/markdown; charset=utf-8");
        return res.end(
          buildAgentProRequiredMarkdown(
            siteUrl,
            `Machine-readable content for shop "${slug}" is only served while the seller's Pro membership is active.`
          )
        );
      }
      return sendAgentError(res, {
        status: 403,
        error: "Pro membership required",
        code: "pro_required",
        message: `Machine-readable content for shop "${slug}" is only served while the seller's Pro membership is active.`,
        slug,
      });
    }

    // Sitemap needs the full seller inventory; other surfaces are previews.
    const isSitemap = format === "sitemap";
    const [shopEvent, profileEvent, sellerEvents, blogEvents] =
      await Promise.all([
        fetchShopProfileByPubkeyFromDb(pubkey),
        fetchProfileByPubkeyFromDb(pubkey),
        fetchProductsByPubkeyFromDb(pubkey, isSitemap ? 100_000 : 500),
        fetchBlogPostsByPubkeyFromDb(pubkey),
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

    const products: StallProductSummary[] = (
      isSitemap ? sellerParsed : sellerParsed.slice(0, 50)
    ).map(({ event, data }) => ({
      title: data.title || "Untitled listing",
      slug: getListingSlug(data, allSellerData) || event.id,
      price: data.price ?? null,
      currency: data.currency || "sats",
      summary: data.summary || "",
      image: data.images?.[0] || "",
    }));

    // Published blog posts (NIP-23), newest-first, with collision-resolved
    // readable slugs. The optional external link-out is never fetched here —
    // parseBlogPostEvent only reads the post's own cached tags/content.
    const parsedPosts = blogEvents
      .map((e) => parseBlogPostEvent(e))
      .filter((p): p is BlogPost => p !== null)
      .sort((a, b) => b.publishedAt - a.publishedAt);
    const blogPosts: StallBlogSummary[] = (
      isSitemap ? parsedPosts : parsedPosts.slice(0, 50)
    ).map((p) => ({
      title: p.title,
      slug: getBlogPostSlug(p, parsedPosts),
      summary: p.summary || "",
      image: p.image || "",
      publishedAt: p.publishedAt,
    }));

    // Single blog post: serve the full article body (markdown/JSON/plain-text/
    // llms) so agents don't have to render the HTML page. The optional external
    // link-out is never fetched — only the post's own cached tags/content are
    // used. Hostile fields are inert here (non-HTML content types + JSON
    // serialization); image/link URLs were http(s)-validated at parse time.
    if (postSlug) {
      const match = findBlogPostBySlug(postSlug, parsedPosts);
      if (!match) {
        if (acceptsMarkdown(req)) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/markdown; charset=utf-8");
          return res.end(
            buildAgentNotFoundMarkdown(
              `${siteUrl}/blog/${postSlug}`,
              `No blog post matches the slug "${postSlug}" in shop "${slug}".`
            )
          );
        }
        return sendAgentError(res, {
          status: 404,
          error: "Blog post not found",
          code: "post_not_found",
          message: `No blog post matches the slug "${postSlug}" in shop "${slug}".`,
          slug,
        });
      }
      const postInput: StallPostInput = {
        shopName: branding.shopName,
        slug,
        siteUrl,
        isCustomDomain,
        post: {
          title: match.title,
          slug: getBlogPostSlug(match, parsedPosts),
          summary: match.summary || "",
          image: match.image || "",
          content: match.content || "",
          publishedAt: match.publishedAt,
          updatedAt: match.updatedAt,
          hashtags: match.hashtags || [],
          ...(match.externalUrl ? { externalUrl: match.externalUrl } : {}),
        },
      };
      switch (format) {
        case "json":
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          return res.status(200).json(buildPostJson(postInput));
        case "txt":
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          return res.status(200).send(buildPostText(postInput));
        case "llms":
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          return res.status(200).send(buildPostLlmsTxt(postInput));
        case "md":
        default:
          res.setHeader("Content-Type", "text/markdown; charset=utf-8");
          return res.status(200).send(buildPostMarkdown(postInput));
      }
    }

    const input: StallContentInput = {
      shopName: branding.shopName,
      about: branding.about,
      image: branding.image,
      slug,
      siteUrl,
      isCustomDomain,
      products,
      blogPosts,
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
