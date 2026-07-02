import { safeFetch, SafeFetchError } from "@/utils/url-safety";
import {
  normalizeHexColor,
  type ExtractedSiteSignals,
} from "@/utils/migrations/site-design";
import type { StorefrontSocialLink } from "@/utils/types/types";

// Server-only: fetches a seller's existing website + a few of its stylesheets
// (all SSRF-guarded via safeFetch) and pulls out the raw design signals we can
// turn into a stall design. Deliberately best-effort — anything it can't find
// is simply omitted so the caller can still build a partial draft.

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_CSS_BYTES = 1 * 1024 * 1024;
const MAX_STYLESHEETS = 4;

export class SiteExtractionError extends Error {}

function decodeEntities(str: string): string {
  return str
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
}

function metaContent(
  html: string,
  key: string,
  attr: "property" | "name" = "property"
): string | undefined {
  const patterns = [
    new RegExp(
      `<meta[^>]+${attr}=["']${key}["'][^>]+content=["']([^"']+)["']`,
      "i"
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+${attr}=["']${key}["']`,
      "i"
    ),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return decodeEntities(m[1]);
  }
  return undefined;
}

function absolute(value: string | undefined, base: URL): string | undefined {
  if (!value) return undefined;
  try {
    const u = new URL(value.trim(), base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

function extractLinkHref(html: string, relPattern: RegExp): string | undefined {
  const linkTags = html.match(/<link\b[^>]*>/gi) || [];
  for (const tag of linkTags) {
    const rel = tag.match(/\brel=["']([^"']+)["']/i)?.[1];
    if (rel && relPattern.test(rel)) {
      const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1];
      if (href) return decodeEntities(href);
    }
  }
  return undefined;
}

function extractStylesheetHrefs(html: string): string[] {
  const linkTags = html.match(/<link\b[^>]*>/gi) || [];
  const hrefs: string[] = [];
  for (const tag of linkTags) {
    const rel = tag.match(/\brel=["']([^"']+)["']/i)?.[1];
    if (rel && /stylesheet/i.test(rel)) {
      const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1];
      if (href) hrefs.push(decodeEntities(href));
    }
  }
  return hrefs;
}

function extractLogo(html: string, base: URL): string | undefined {
  const ogLogo = metaContent(html, "og:logo");
  if (ogLogo) return absolute(ogLogo, base);

  const imgTags = html.match(/<img\b[^>]*>/gi) || [];
  for (const tag of imgTags) {
    const hay = tag.toLowerCase();
    if (hay.includes("logo")) {
      const src =
        tag.match(/\bsrc=["']([^"']+)["']/i)?.[1] ||
        tag.match(/\bdata-src=["']([^"']+)["']/i)?.[1];
      if (src) return absolute(decodeEntities(src), base);
    }
  }
  return undefined;
}

const SOCIAL_HOST_MAP: {
  re: RegExp;
  platform: StorefrontSocialLink["platform"];
}[] = [
  { re: /instagram\.com/i, platform: "instagram" },
  { re: /(twitter\.com|x\.com)/i, platform: "x" },
  { re: /facebook\.com/i, platform: "facebook" },
  { re: /youtube\.com|youtu\.be/i, platform: "youtube" },
  { re: /tiktok\.com/i, platform: "tiktok" },
  { re: /t\.me|telegram\.me/i, platform: "telegram" },
];

function extractSocialLinks(html: string, base: URL): StorefrontSocialLink[] {
  const hrefs = html.match(/href=["']([^"']+)["']/gi) || [];
  const seen = new Map<string, StorefrontSocialLink>();
  for (const raw of hrefs) {
    const href = raw.match(/href=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    for (const { re, platform } of SOCIAL_HOST_MAP) {
      if (re.test(href) && !seen.has(platform)) {
        const abs = absolute(decodeEntities(href), base);
        if (abs) seen.set(platform, { platform, url: abs });
      }
    }
  }
  return Array.from(seen.values());
}

function extractAboutText(html: string): string | undefined {
  // Strip script/style, then find the longest paragraph's text as a rough
  // "about" candidate. Meta description is a better default and is handled by
  // the caller; this is a fallback for richer copy.
  const cleaned = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  const paragraphs = cleaned.match(/<p\b[^>]*>([\s\S]*?)<\/p>/gi) || [];
  let best = "";
  for (const p of paragraphs) {
    const text = decodeEntities(
      p.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ")
    );
    if (text.length > best.length && text.length <= 1200) best = text;
  }
  return best.length >= 40 ? best : undefined;
}

function collectColors(css: string, counts: Map<string, number>): void {
  const matches = css.match(/#[0-9a-fA-F]{3,6}\b|rgba?\([^)]*\)/g) || [];
  for (const raw of matches) {
    const hex = normalizeHexColor(raw);
    if (hex) counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
}

function collectFonts(css: string, fonts: Set<string>): void {
  const decls = css.match(/font-family\s*:\s*([^;}"]+)/gi) || [];
  for (const decl of decls) {
    const value = decl.replace(/font-family\s*:/i, "").trim();
    const first = value.split(",")[0]?.replace(/["']/g, "").trim();
    if (first) fonts.add(first);
  }
  // Google Fonts <link> family params are captured separately by the caller.
}

function extractGoogleFontFamilies(html: string): string[] {
  const fonts = new Set<string>();
  const links = html.match(/https:\/\/fonts\.googleapis\.com\/[^"']+/gi) || [];
  for (const link of links) {
    const familyParams = link.match(/family=([^&"']+)/gi) || [];
    for (const fp of familyParams) {
      const name = decodeURIComponent(
        fp.replace(/family=/i, "").split(":")[0]!
      ).replace(/\+/g, " ");
      if (name) fonts.add(name.trim());
    }
  }
  return Array.from(fonts);
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const buf = await res.arrayBuffer();
  const slice = buf.byteLength > maxBytes ? buf.slice(0, maxBytes) : buf;
  return new TextDecoder("utf-8").decode(slice);
}

export async function extractSiteSignals(
  inputUrl: string
): Promise<ExtractedSiteSignals> {
  let res: Response;
  try {
    res = await safeFetch(inputUrl, {
      followRedirects: true,
      timeoutMs: 8000,
      accept: "text/html,application/xhtml+xml",
    });
  } catch (err) {
    if (err instanceof SafeFetchError) {
      throw new SiteExtractionError(err.message);
    }
    throw new SiteExtractionError("Could not reach that website");
  }

  if (!res.ok) {
    throw new SiteExtractionError(
      `That website returned an error (HTTP ${res.status})`
    );
  }
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) {
    throw new SiteExtractionError("That URL did not return a web page");
  }

  // The final URL after redirects is the correct base for relative links.
  const base = new URL(res.url || inputUrl);
  const html = await readCapped(res, MAX_HTML_BYTES);

  const siteName = metaContent(html, "og:site_name");
  const title =
    metaContent(html, "og:title") ||
    metaContent(html, "twitter:title") ||
    html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();
  const description =
    metaContent(html, "og:description") ||
    metaContent(html, "twitter:description") ||
    metaContent(html, "description", "name");
  const ogImage = absolute(
    metaContent(html, "og:image") ||
      metaContent(html, "og:image:url") ||
      metaContent(html, "twitter:image"),
    base
  );
  const themeColor = metaContent(html, "theme-color", "name");
  const logoUrl = extractLogo(html, base);
  const faviconUrl = absolute(
    extractLinkHref(html, /apple-touch-icon/i) ||
      extractLinkHref(html, /(^|\s)icon(\s|$)/i),
    base
  );

  const colorCounts = new Map<string, number>();
  const fonts = new Set<string>();

  // Inline <style> blocks.
  const inlineStyles = html.match(/<style\b[^>]*>([\s\S]*?)<\/style>/gi) || [];
  for (const block of inlineStyles) {
    const css = block.replace(/<\/?style[^>]*>/gi, "");
    collectColors(css, colorCounts);
    collectFonts(css, fonts);
  }
  // Inline style="" attributes (brand colors often live here).
  const styleAttrs = html.match(/style=["']([^"']+)["']/gi) || [];
  for (const attr of styleAttrs) {
    collectColors(attr, colorCounts);
  }

  // A few linked stylesheets.
  const sheetHrefs = extractStylesheetHrefs(html)
    .map((href) => absolute(href, base))
    .filter((u): u is string => !!u)
    .slice(0, MAX_STYLESHEETS);
  for (const href of sheetHrefs) {
    try {
      const cssRes = await safeFetch(href, {
        followRedirects: true,
        timeoutMs: 6000,
        accept: "text/css,*/*",
      });
      if (!cssRes.ok) continue;
      const css = await readCapped(cssRes, MAX_CSS_BYTES);
      collectColors(css, colorCounts);
      collectFonts(css, fonts);
    } catch {
      // Skip unreachable/blocked stylesheets — best effort.
    }
  }

  for (const gf of extractGoogleFontFamilies(html)) fonts.add(gf);

  const colors = Array.from(colorCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([hex]) => hex);

  const socialLinks = extractSocialLinks(html, base);
  const aboutText = extractAboutText(html);

  return {
    url: base.toString(),
    siteName,
    title,
    description,
    aboutText,
    ogImage,
    logoUrl,
    faviconUrl,
    themeColor,
    colors,
    fonts: Array.from(fonts),
    socialLinks,
  };
}

/** True when we found enough to build a meaningful draft. */
export function hasUsableSignals(signals: ExtractedSiteSignals): boolean {
  return Boolean(
    signals.title ||
    signals.siteName ||
    signals.description ||
    signals.ogImage ||
    signals.logoUrl ||
    signals.colors.length > 0
  );
}
