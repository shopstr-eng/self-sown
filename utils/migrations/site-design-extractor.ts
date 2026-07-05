import { safeFetch, SafeFetchError } from "@/utils/url-safety";
import {
  normalizeHexColor,
  type ExtractedSiteSignals,
} from "@/utils/migrations/site-design";
import type {
  StorefrontSocialLink,
  StorefrontNavLayout,
} from "@/utils/types/types";

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

// Read at most `maxBytes` of a response body, streaming so a hostile origin
// can't OOM us by advertising fast headers then sending gigabytes (or slow-
// dripping forever). safeFetch clears its abort timeout once headers arrive, so
// this owns its own overall read deadline. Critical now that the extraction
// pipeline is reachable from the PUBLIC /api/storefront/preview-from-url.
async function readCapped(
  res: Response,
  maxBytes: number,
  timeoutMs = 8000
): Promise<string> {
  const body = res.body;
  if (!body) {
    // No readable stream (e.g. a polyfilled Response); fall back to a bounded
    // buffer read. Still capped, just without incremental protection.
    const buf = await res.arrayBuffer();
    const slice = buf.byteLength > maxBytes ? buf.slice(0, maxBytes) : buf;
    return new TextDecoder("utf-8").decode(slice);
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  const deadline = Date.now() + timeoutMs;
  try {
    while (received < maxBytes) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break; // slow origin: keep what we have and stop
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutP = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), remainingMs);
      });
      let result: Awaited<ReturnType<typeof reader.read>> | null;
      try {
        result = await Promise.race([reader.read(), timeoutP]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (!result || result.done) break;
      const value = result.value;
      if (!value) continue;
      const remaining = maxBytes - received;
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        received += remaining;
        break;
      }
      chunks.push(value);
      received += value.byteLength;
    }
  } finally {
    // Stop the transfer — we have enough, timed out, or the origin misbehaved.
    await reader.cancel().catch(() => {});
  }

  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(merged);
}

const MAX_CONTENT_IMAGES = 5;
const MAX_CONTENT_BLOCKS = 4;
const MAX_JSONLD_PRODUCTS = 8;

// Junk we never want to promote into a storefront section image: logos, icons,
// tracking pixels and UI chrome. Matched against the whole <img> tag (src +
// class + id) plus its alt text, so a hit anywhere disqualifies the image.
const JUNK_IMAGE_RE =
  /logo|icon|favicon|sprite|pixel|tracking|beacon|avatar|badge|emoji|spinner|loader|placeholder|1x1|blank|arrow|chevron|bullet|thumb/i;

// Boilerplate headings/paragraphs that aren't real page content and shouldn't
// become a storefront text section.
const JUNK_TEXT_RE =
  /cookie|newsletter|subscribe|sign\s?up|sign\s?in|log\s?in|add to cart|checkout|©|copyright|all rights reserved|privacy policy|terms of service|terms (&|and) conditions|skip to (main )?content/i;

function cleanInlineText(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

// Pick the highest-resolution candidate out of a srcset. Candidates are
// "url descriptor" pairs; the descriptor is a width ("600w") or pixel density
// ("2x"). No descriptor is treated as the smallest so a real-sized sibling wins.
function pickLargestSrcsetCandidate(srcset: string): string | undefined {
  let bestUrl: string | undefined;
  let bestWidth = -1;
  for (const part of srcset.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [url, descriptor] = trimmed.split(/\s+/);
    if (!url || /^data:/i.test(url)) continue;
    const d = descriptor?.toLowerCase();
    let width = 1;
    if (d?.endsWith("w")) width = parseInt(d, 10) || 1;
    else if (d?.endsWith("x")) width = (parseFloat(d) || 1) * 1000;
    if (width > bestWidth) {
      bestWidth = width;
      bestUrl = url;
    }
  }
  return bestUrl;
}

// ponytail: only strips the two CDN size conventions that reliably map back to
// the original file (Shopify `_WxH`/`_Wx`, WooCommerce `-WxH` before the file
// extension). A rare real filename like `part-10x20.jpg` would be mis-stripped;
// ceiling accepted — rehost is fail-open, so a 404 on the stripped URL keeps the
// original untouched URL rather than dropping the image.
function stripImageSizeSuffix(url: string): string {
  return url
    .replace(/_\d+x\d*(@\d+x)?(?=\.[a-z]{3,4}([?#]|$))/i, "")
    .replace(/-\d+x\d+(?=\.[a-z]{3,4}([?#]|$))/i, "");
}

function pickImageSrc(tag: string): string | undefined {
  const srcset =
    tag.match(/\bsrcset=["']([^"']+)["']/i)?.[1] ||
    tag.match(/\bdata-srcset=["']([^"']+)["']/i)?.[1];
  const largest = srcset ? pickLargestSrcsetCandidate(srcset) : undefined;
  return (
    largest ||
    tag.match(/\bdata-src=["']([^"']+)["']/i)?.[1] ||
    tag.match(/\bdata-lazy-src=["']([^"']+)["']/i)?.[1] ||
    tag.match(/\bsrc=["']([^"']+)["']/i)?.[1]
  );
}

function imageAttrTooSmall(tag: string): boolean {
  const w = Number(tag.match(/\bwidth=["']?(\d+)/i)?.[1] ?? "");
  const h = Number(tag.match(/\bheight=["']?(\d+)/i)?.[1] ?? "");
  return (w > 0 && w < 100) || (h > 0 && h < 100);
}

/**
 * Pull a handful of real content images (banners, feature graphics) from the
 * page in document order, skipping logos/icons/tracking pixels and anything we
 * already used elsewhere (og image, logo, favicon). These become extra
 * storefront `image` sections.
 */
function extractContentImages(
  html: string,
  base: URL,
  exclude: Set<string>
): { url: string; alt?: string }[] {
  const tags = html.match(/<img\b[^>]*>/gi) || [];
  const out: { url: string; alt?: string }[] = [];
  const seen = new Set<string>(exclude);
  for (const tag of tags) {
    if (out.length >= MAX_CONTENT_IMAGES) break;
    const raw = pickImageSrc(tag);
    if (!raw) continue;
    const decoded = decodeEntities(raw);
    if (/^data:/i.test(decoded)) continue;
    const altRaw = tag.match(/\balt=["']([^"']*)["']/i)?.[1];
    const alt = altRaw ? decodeEntities(altRaw) : undefined;
    const hay = `${tag} ${alt ?? ""}`.toLowerCase();
    if (JUNK_IMAGE_RE.test(hay)) continue;
    if (imageAttrTooSmall(tag)) continue;
    const absRaw = absolute(decoded, base);
    if (!absRaw) continue;
    if (/\.svg(\?|#|$)/i.test(absRaw)) continue;
    // Upgrade CDN thumbnails to the full-resolution original for best quality.
    const abs = stripImageSizeSuffix(absRaw);
    const key = abs.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url: abs, alt: alt && alt.length > 0 ? alt : undefined });
  }
  return out;
}

/**
 * Pull ordered heading + paragraph blocks from the page body so the site's own
 * sections of copy become extra storefront `text` sections. Only keeps blocks
 * that have BOTH a real heading and a substantial paragraph, so we never
 * fabricate headings or ship nav/cookie boilerplate.
 */
function extractContentBlocks(
  html: string
): { heading: string; body: string }[] {
  const cleaned = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<(nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");

  const tokenRe =
    /<(h[1-3])\b[^>]*>([\s\S]*?)<\/\1>|<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  const blocks: { heading: string; body: string }[] = [];
  let heading: string | null = null;
  let body: string[] = [];

  const flush = () => {
    if (heading) {
      const text = body.join("\n\n").trim();
      if (text.length >= 40) blocks.push({ heading, body: text.slice(0, 800) });
    }
    heading = null;
    body = [];
  };

  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(cleaned)) !== null) {
    if (match[1]) {
      flush();
      const h = cleanInlineText(match[2] || "");
      heading =
        h.length >= 3 && h.length <= 80 && !JUNK_TEXT_RE.test(h) ? h : null;
    } else if (heading) {
      const p = cleanInlineText(match[3] || "");
      if (p.length >= 20 && !JUNK_TEXT_RE.test(p)) body.push(p);
    }
  }
  flush();

  return blocks.slice(0, MAX_CONTENT_BLOCKS);
}

/**
 * Pull product cards from the page's schema.org JSON-LD (Product / ItemList).
 * Deterministic and best-effort — malformed JSON blocks are skipped. Values are
 * used only to render placeholder product cards in the import preview; they are
 * never written to a StorefrontConfig, so this never leaks URLs into saved data.
 */
function extractJsonLdProducts(
  html: string,
  base: URL
): { title: string; image?: string; price?: number; currency?: string }[] {
  const out: {
    title: string;
    image?: string;
    price?: number;
    currency?: string;
  }[] = [];
  const seen = new Set<string>();

  const asRecord = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;

  const firstImage = (img: unknown): string | undefined => {
    if (typeof img === "string") return img;
    if (Array.isArray(img)) {
      const first = img[0];
      if (typeof first === "string") return first;
      const rec = asRecord(first);
      return typeof rec?.url === "string" ? rec.url : undefined;
    }
    const rec = asRecord(img);
    return typeof rec?.url === "string" ? rec.url : undefined;
  };

  const isProductType = (t: unknown): boolean => {
    if (typeof t === "string") return t.toLowerCase() === "product";
    if (Array.isArray(t))
      return t.some((x) => String(x).toLowerCase() === "product");
    return false;
  };

  const pushProduct = (rec: Record<string, unknown>): void => {
    if (out.length >= MAX_JSONLD_PRODUCTS) return;
    if (!isProductType(rec["@type"])) return;
    const title =
      typeof rec.name === "string"
        ? cleanInlineText(rec.name).slice(0, 120)
        : "";
    if (title.length < 2) return;
    const key = title.toLowerCase();
    if (seen.has(key)) return;

    const imageRaw = firstImage(rec.image);
    const image = imageRaw
      ? absolute(decodeEntities(imageRaw), base)
      : undefined;

    let price: number | undefined;
    let currency: string | undefined;
    const offers = asRecord(
      Array.isArray(rec.offers) ? rec.offers[0] : rec.offers
    );
    if (offers) {
      const p = offers.price ?? offers.lowPrice ?? offers.highPrice;
      const parsed =
        typeof p === "number" ? p : parseFloat(String(p ?? "").trim());
      if (Number.isFinite(parsed) && parsed >= 0) price = parsed;
      if (typeof offers.priceCurrency === "string")
        currency = offers.priceCurrency.trim().slice(0, 8).toUpperCase();
    }

    seen.add(key);
    out.push({ title, image: image || undefined, price, currency });
  };

  const walk = (node: unknown, depth: number): void => {
    if (out.length >= MAX_JSONLD_PRODUCTS || depth > 6) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const rec = asRecord(node);
    if (!rec) return;
    pushProduct(rec);
    walk(rec["@graph"], depth + 1);
    walk(rec.itemListElement, depth + 1);
    walk(rec.item, depth + 1);
    walk(rec.mainEntity, depth + 1);
  };

  const scripts =
    html.match(
      /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    ) || [];
  for (const block of scripts) {
    if (out.length >= MAX_JSONLD_PRODUCTS) break;
    const jsonText = block
      .replace(/^<script\b[^>]*>/i, "")
      .replace(/<\/script>\s*$/i, "")
      .trim();
    if (!jsonText) continue;
    try {
      walk(JSON.parse(jsonText), 0);
    } catch {
      // Malformed JSON-LD — skip, best effort.
    }
  }

  return out;
}

/**
 * Best-effort, conservative nav-layout detection. v1 only recognizes a CENTERED
 * logo from explicit class hints in the header/nav markup; anything else (and
 * any ambiguity) falls through to the historical left-aligned default. We never
 * emit "above"/"below" — those need layout metrics static HTML can't give
 * without false positives.
 */
function detectNavLayout(html: string): StorefrontNavLayout | undefined {
  const region =
    html.match(/<header\b[^>]*>[\s\S]*?<\/header>/i)?.[0] ||
    html.match(/<nav\b[^>]*>[\s\S]*?<\/nav>/i)?.[0];
  if (!region) return undefined;
  const centeredHint =
    /\b(?:logo[-_]?cent(?:er|re)d?|cent(?:er|re)d?[-_]?logo|centered[-_]?(?:logo|nav|header|menu)|(?:logo|nav|header|menu)[-_]?centered|(?:header|nav)--cent(?:er|re)d?)\b/i;
  return centeredHint.test(region) ? { logoPosition: "center" } : undefined;
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

  // Images already spoken for elsewhere shouldn't be repeated as content
  // sections.
  const usedImageUrls = new Set<string>();
  for (const u of [ogImage, logoUrl, faviconUrl]) {
    if (u) usedImageUrls.add(u.toLowerCase());
  }
  const images = extractContentImages(html, base, usedImageUrls);
  const contentBlocks = extractContentBlocks(html);
  const products = extractJsonLdProducts(html, base);
  const navLayout = detectNavLayout(html);

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
    images,
    contentBlocks,
    products,
    navLayout,
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
