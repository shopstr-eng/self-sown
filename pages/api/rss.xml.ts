import type { NextApiRequest, NextApiResponse } from "next";
import { fetchAllProductsFromDb } from "@/utils/db/db-service";
import parseTags, {
  ProductData,
} from "@/utils/parsers/product-parser-functions";
import { getListingSlug } from "@/utils/url-slugs";

const BASE_URL = "https://milk.market";

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export default async function handler(
  _req: NextApiRequest,
  res: NextApiResponse
) {
  let items = "";

  try {
    const events = await fetchAllProductsFromDb(50, 0);
    const parsed = events
      .map((event) => ({ event, data: parseTags(event) }))
      .filter(
        (
          entry
        ): entry is { event: (typeof events)[number]; data: ProductData } =>
          !!entry.data
      );
    const allParsed = parsed.map((entry) => entry.data);

    items = parsed
      .map(({ event, data }) => {
        const slug = getListingSlug(data, allParsed) || event.id;
        const link = `${BASE_URL}/listing/${slug}`;
        const title = escapeXml(data.title || "Untitled listing");
        const description = escapeXml(
          data.summary || "A local food listing on Milk Market."
        );
        const pubDate = new Date(
          (event.created_at || Math.floor(Date.now() / 1000)) * 1000
        ).toUTCString();
        const priceInfo =
          data.price != null
            ? ` (${data.price}${data.currency ? " " + escapeXml(data.currency) : ""})`
            : "";
        const image = data.images?.[0]
          ? `\n      <enclosure url="${escapeXml(data.images[0])}" type="image/jpeg" />`
          : "";
        return `    <item>
      <title>${title}${priceInfo}</title>
      <link>${link}</link>
      <guid isPermaLink="false">${escapeXml(event.id)}</guid>
      <description>${description}</description>
      <pubDate>${pubDate}</pubDate>${image}
    </item>`;
      })
      .join("\n");
  } catch (error) {
    console.error("Failed to build RSS feed:", error);
  }

  const lastBuild = new Date().toUTCString();
  const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Milk Market: Local Food Listings</title>
    <link>${BASE_URL}/marketplace</link>
    <atom:link href="${BASE_URL}/rss.xml" rel="self" type="application/rss+xml" />
    <description>Recent product listings from local food producers on Milk Market, a permissionless Bitcoin-native marketplace built on Nostr.</description>
    <language>en-us</language>
    <lastBuildDate>${lastBuild}</lastBuildDate>
    <ttl>60</ttl>
${items}
  </channel>
</rss>`;

  res.setHeader("Content-Type", "application/rss+xml; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=600, s-maxage=600");
  res.status(200).send(feed);
}
