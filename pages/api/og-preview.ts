import type { NextApiRequest, NextApiResponse } from "next";
import { applyRateLimit } from "@/utils/rate-limit";
import { isSafePublicHostname } from "@/utils/url-safety";

// Each call performs an outbound HTTPS fetch + HTML parse; tight per-IP
// cap to prevent us from being used as an SSRF amplifier.
const RATE_LIMIT = { limit: 60, windowMs: 60 * 1000 };

type OGData = {
  title?: string;
  description?: string;
  image?: string;
  url?: string;
};

const cache = new Map<string, { data: OGData; timestamp: number }>();
const CACHE_TTL = 1000 * 60 * 30;

function decodeHTMLEntities(str: string): string {
  return str
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
}

function extractMeta(
  html: string,
  property: string,
  attr: "property" | "name" = "property"
): string | undefined {
  const patterns = [
    new RegExp(
      `<meta[^>]+${attr}=["']${property}["'][^>]+content=["']([^"']+)["']`,
      "i"
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+${attr}=["']${property}["']`,
      "i"
    ),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return decodeHTMLEntities(m[1]);
  }
  return undefined;
}

function normalizeHttpUrl(value: string | undefined, baseUrl: string): string {
  if (!value) return baseUrl;

  try {
    const parsed = new URL(value.trim(), baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return baseUrl;
    }
    return parsed.toString();
  } catch {
    return baseUrl;
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (!(await applyRateLimit(req, res, "og-preview", RATE_LIMIT))) return;

  const { url } = req.query;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Missing url" });
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return res.status(400).json({ error: "Invalid protocol" });
    }
    if (parsedUrl.port && !["80", "443"].includes(parsedUrl.port)) {
      return res.status(400).json({ error: "Invalid port" });
    }
  } catch {
    return res.status(400).json({ error: "Invalid URL" });
  }

  const isSafeHost = await isSafePublicHostname(parsedUrl.hostname);
  if (!isSafeHost) {
    return res.status(400).json({ error: "URL host is not allowed" });
  }

  const normalizedUrl = parsedUrl.toString();
  const cached = cache.get(normalizedUrl);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    res.setHeader("Cache-Control", "public, max-age=1800");
    return res.status(200).json(cached.data);
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const response = await fetch(normalizedUrl, {
      signal: controller.signal,
      redirect: "manual",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; MilkMarket/1.0; +https://milk.market)",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return res.status(200).json({});
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) {
      return res.status(200).json({});
    }

    const html = await response.text();
    const ogData: OGData = {};

    ogData.title =
      extractMeta(html, "og:title") ??
      extractMeta(html, "twitter:title") ??
      html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();

    ogData.description =
      extractMeta(html, "og:description") ??
      extractMeta(html, "twitter:description") ??
      extractMeta(html, "description", "name");

    const rawImage =
      extractMeta(html, "og:image") ??
      extractMeta(html, "og:image:url") ??
      extractMeta(html, "twitter:image");

    if (rawImage) {
      if (rawImage.startsWith("//")) {
        ogData.image = "https:" + rawImage;
      } else if (rawImage.startsWith("/")) {
        ogData.image = `${parsedUrl.protocol}//${parsedUrl.host}${rawImage}`;
      } else {
        ogData.image = rawImage;
      }
    }

    ogData.url = normalizeHttpUrl(extractMeta(html, "og:url"), normalizedUrl);

    if (ogData.title) {
      cache.set(normalizedUrl, { data: ogData, timestamp: Date.now() });
    }

    res.setHeader("Cache-Control", "public, max-age=1800");
    return res.status(200).json(ogData);
  } catch {
    return res.status(200).json({});
  }
}
