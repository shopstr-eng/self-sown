import type { NextApiRequest, NextApiResponse } from "next";
import {
  getDbPool,
  fetchStorefrontBlogPostEventsForSitemap,
} from "@/utils/db/db-service";
import { parseBlogPostEvent, type BlogPost } from "@self-sown/domain";
import { getBlogPostSlug } from "@/utils/url-slugs";
import { nip19 } from "nostr-tools";
import { SITE_URL } from "@/utils/site-url";
import { SEO_PAGE_PATHS } from "@/utils/seo";
import { getMembershipView } from "@/utils/pro/membership";

const BASE_URL = SITE_URL;

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function urlEntry(
  loc: string,
  lastmod: string,
  changefreq: string,
  priority: string
): string {
  return `  <url>
    <loc>${xmlEscape(loc)}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`;
}

function toDate(createdAt: unknown, fallback: string): string {
  if (typeof createdAt === "number" && createdAt > 0) {
    return new Date(createdAt * 1000).toISOString().slice(0, 10);
  }
  return fallback;
}

export default async function handler(
  _req: NextApiRequest,
  res: NextApiResponse
) {
  const currentDate = new Date().toISOString().slice(0, 10);
  const entries: string[] = [];
  // Stall slug → live custom-domain origin, filled by the stall query below
  // and reused by the blog section (root-mapped: /blog/<post>, no /stall
  // prefix). Empty when the stall/domain lookups fail — blog URLs then fall
  // back to the platform paths, same as stalls do.
  const originBySlug = new Map<string, string>();

  const staticPages: Array<{
    url: string;
    changefreq: string;
    priority: string;
  }> = [
    { url: "/", changefreq: "daily", priority: "1.0" },
    { url: "/marketplace", changefreq: "daily", priority: "0.9" },
    { url: "/producer-guide", changefreq: "weekly", priority: "0.8" },
    { url: "/about", changefreq: "monthly", priority: "0.7" },
    { url: "/manifesto", changefreq: "yearly", priority: "0.7" },
    { url: "/contact", changefreq: "monthly", priority: "0.7" },
    { url: "/faq", changefreq: "weekly", priority: "0.6" },
    { url: "/developers", changefreq: "monthly", priority: "0.6" },
    { url: "/terms", changefreq: "monthly", priority: "0.3" },
    { url: "/privacy", changefreq: "monthly", priority: "0.3" },
    { url: "/communities", changefreq: "daily", priority: "0.7" },
  ];

  for (const p of staticPages) {
    entries.push(
      urlEntry(`${BASE_URL}${p.url}`, currentDate, p.changefreq, p.priority)
    );
  }

  // Programmatic comparison/guide pages (/vs/*, /alternatives/*, /best/*) —
  // enumerated from the content registry so new pages appear automatically.
  for (const path of SEO_PAGE_PATHS) {
    entries.push(urlEntry(`${BASE_URL}${path}`, currentDate, "monthly", "0.5"));
  }

  // Stall rows and live custom-domain candidates are fetched on the pooled
  // client below, but the membership gate runs and the stall entries are
  // emitted only AFTER the client is released: getMembershipView acquires
  // its own pool connection, and nesting that acquisition inside ours can
  // starve the pool (max 10) when concurrent sitemap requests each hold a
  // client while their membership lookups queue for one.
  let stallRows: Array<{
    slug?: string | null;
    pubkey?: string | null;
    created_at?: unknown;
  }> = [];
  let domainRows: Array<{ pubkey?: string | null; domain?: string | null }> =
    [];

  try {
    const pool = getDbPool();
    const client = await pool.connect();
    try {
      // Stall / storefront pages — one entry per registered slug. A seller
      // with a LIVE custom domain gets their custom-domain origin (the stall
      // is root-mapped there) instead of the platform /stall/<slug> URL, so
      // the sitemap's canonicalization hint agrees with the permanent
      // redirect the stall page actually issues. The gate mirrors
      // utils/storefront/stall-custom-domain-redirect.ts exactly — verified
      // AND tls_status "active" AND membership not hidden. The TLS half
      // matters here just as it does for the redirect: a verified-only bar
      // would hand crawlers a URL whose certificate may not exist yet.
      const stallsResult = await client.query(
        `SELECT slug, pubkey, created_at FROM shop_slugs ORDER BY created_at DESC LIMIT 2000`
      );
      stallRows = stallsResult.rows;
      const stallPubkeys = [
        ...new Set(
          stallRows
            .map((r) => r.pubkey)
            .filter((p): p is string => typeof p === "string" && !!p)
        ),
      ];
      if (stallPubkeys.length > 0) {
        try {
          const domainsResult = await client.query(
            `SELECT pubkey, domain FROM custom_domains
               WHERE pubkey = ANY($1) AND verified = true AND tls_status = 'active'`,
            [stallPubkeys]
          );
          domainRows = domainsResult.rows;
        } catch (err) {
          // Fail toward platform URLs: a domain-lookup blip must not drop the
          // already-fetched stall entries (or the listings/communities below)
          // from a sitemap that gets cached for an hour.
          console.error("sitemap.xml custom-domain query failed:", err);
        }
      }

      // Listing pages — use the d-tag (stable identifier) from product events.
      const listingsResult = await client.query(
        `SELECT DISTINCT ON (d_tag)
           COALESCE(
             (SELECT elem->>1 FROM jsonb_array_elements(tags) elem WHERE elem->>0 = 'd' LIMIT 1),
             id
           ) AS d_tag,
           created_at
         FROM product_events
         WHERE kind = 30402
         ORDER BY d_tag, created_at DESC
         LIMIT 2000`
      );
      for (const row of listingsResult.rows) {
        const dTag = row.d_tag as string | null | undefined;
        if (!dTag) continue;
        const lastmod = toDate(row.created_at, currentDate);
        entries.push(
          urlEntry(
            `${BASE_URL}/listing/${encodeURIComponent(dTag)}`,
            lastmod,
            "weekly",
            "0.8"
          )
        );
      }

      // Community pages — encode each community definition event as naddr.
      const communitiesResult = await client.query(
        `SELECT pubkey, tags, created_at
         FROM community_events
         WHERE kind = 34550
         ORDER BY created_at DESC
         LIMIT 500`
      );
      for (const row of communitiesResult.rows) {
        const pubkey = row.pubkey as string | null | undefined;
        if (!pubkey) continue;
        const tags = row.tags as Array<[string, string]> | null | undefined;
        const dTag = tags?.find((t) => t[0] === "d")?.[1];
        if (!dTag) continue;
        try {
          const naddr = nip19.naddrEncode({
            kind: 34550,
            pubkey,
            identifier: dTag,
            relays: [],
          });
          const lastmod = toDate(row.created_at, currentDate);
          entries.push(
            urlEntry(
              `${BASE_URL}/communities/${naddr}`,
              lastmod,
              "weekly",
              "0.6"
            )
          );
        } catch {
          // Skip malformed events
        }
      }
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("sitemap.xml DB query failed:", err);
    // Fall through — static pages were already added above.
  }

  // Resolve the membership half of the custom-domain gate and emit the stall
  // entries. Deliberately AFTER the pooled client is released (see above):
  // getMembershipView checks out its own connection per call. The candidate
  // set is bounded to sellers with a live verified domain, so the sequential
  // lookups stay few.
  for (const row of domainRows) {
    const pubkey = row.pubkey;
    const domain = row.domain;
    if (!pubkey || !domain) continue;
    try {
      // Hidden sellers (lapsed past the read-only window) stop resolving on
      // their custom domain entirely — keep their platform URLs, same as the
      // redirect gate.
      const view = await getMembershipView(pubkey);
      if (view.isHidden) continue;
    } catch (err) {
      // Fail toward the platform URL: it is always a valid response, and a
      // membership-lookup blip must not drop the custom-domain seller's
      // stall from the sitemap entirely or point crawlers at a domain that
      // may not be serving.
      console.error("sitemap.xml membership lookup failed:", err);
      continue;
    }
    for (const stall of stallRows) {
      if (stall.slug && stall.pubkey === pubkey) {
        originBySlug.set(stall.slug, `https://${domain}`);
      }
    }
  }
  for (const row of stallRows) {
    const slug = row.slug as string | null | undefined;
    if (!slug) continue;
    const lastmod = toDate(row.created_at, currentDate);
    const origin = originBySlug.get(slug);
    entries.push(
      urlEntry(
        origin ?? `${BASE_URL}/stall/${encodeURIComponent(slug)}`,
        lastmod,
        "weekly",
        "0.8"
      )
    );
    entries.push(
      urlEntry(
        `${BASE_URL}/marketplace/${encodeURIComponent(slug)}`,
        lastmod,
        "weekly",
        "0.7"
      )
    );
  }

  // Blog posts — one entry per published post under its stall's blog path. Done
  // outside the client block above so a blog query failure can't drop the rest
  // of the sitemap. Posts are grouped per stall slug so collision-resolved
  // readable slugs match what the storefront actually serves.
  try {
    const blogRows = await fetchStorefrontBlogPostEventsForSitemap(2000);
    const postsBySlug = new Map<string, BlogPost[]>();
    for (const { slug, event } of blogRows) {
      if (!slug) continue;
      const post = parseBlogPostEvent(event);
      if (!post) continue;
      const arr = postsBySlug.get(slug) ?? [];
      arr.push(post);
      postsBySlug.set(slug, arr);
    }
    for (const [slug, posts] of postsBySlug) {
      for (const post of posts) {
        const postSlug = getBlogPostSlug(post, posts);
        const lastmod = toDate(post.updatedAt, currentDate);
        // On a custom domain the stall is root-mapped, so the blog path drops
        // the /stall/<slug> prefix — same mapping the 308 redirect applies.
        const origin = originBySlug.get(slug);
        entries.push(
          urlEntry(
            origin
              ? `${origin}/blog/${encodeURIComponent(postSlug)}`
              : `${BASE_URL}/stall/${encodeURIComponent(
                  slug
                )}/blog/${encodeURIComponent(postSlug)}`,
            lastmod,
            "monthly",
            "0.6"
          )
        );
      }
    }
  } catch (err) {
    console.error("sitemap.xml blog query failed:", err);
    // Fall through — the rest of the sitemap is already built.
  }

  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join("\n")}
</urlset>`;

  res.setHeader("Content-Type", "application/xml");
  res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600");
  res.status(200).send(sitemap);
}
