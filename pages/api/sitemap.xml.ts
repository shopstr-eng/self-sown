import type { NextApiRequest, NextApiResponse } from "next";
import { getDbPool } from "@/utils/db/db-service";
import { nip19 } from "nostr-tools";

const BASE_URL = "https://milk.market";

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

  const staticPages: Array<{
    url: string;
    changefreq: string;
    priority: string;
  }> = [
    { url: "/", changefreq: "daily", priority: "1.0" },
    { url: "/marketplace", changefreq: "daily", priority: "0.9" },
    { url: "/producer-guide", changefreq: "weekly", priority: "0.8" },
    { url: "/about", changefreq: "monthly", priority: "0.7" },
    { url: "/contact", changefreq: "monthly", priority: "0.7" },
    { url: "/faq", changefreq: "weekly", priority: "0.6" },
    { url: "/terms", changefreq: "monthly", priority: "0.3" },
    { url: "/privacy", changefreq: "monthly", priority: "0.3" },
    { url: "/communities", changefreq: "daily", priority: "0.7" },
  ];

  for (const p of staticPages) {
    entries.push(
      urlEntry(`${BASE_URL}${p.url}`, currentDate, p.changefreq, p.priority)
    );
  }

  try {
    const pool = getDbPool();
    const client = await pool.connect();
    try {
      // Stall / storefront pages — one entry per registered slug.
      const stallsResult = await client.query(
        `SELECT slug, created_at FROM shop_slugs ORDER BY created_at DESC LIMIT 2000`
      );
      for (const row of stallsResult.rows) {
        const slug = row.slug as string | null | undefined;
        if (!slug) continue;
        const lastmod = toDate(row.created_at, currentDate);
        entries.push(
          urlEntry(
            `${BASE_URL}/stall/${encodeURIComponent(slug)}`,
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

  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join("\n")}
</urlset>`;

  res.setHeader("Content-Type", "application/xml");
  res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600");
  res.status(200).send(sitemap);
}
