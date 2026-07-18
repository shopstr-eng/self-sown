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

// Headings that mark a genuine "about" region of the page.
const ABOUT_HEADING_RE =
  /\babout\b|our story|who we are|our (farm|family|mission|herd|history)/i;
// Legal / regulatory boilerplate that must never become the shop's about copy
// (e.g. FDA interstate-commerce disclaimers on raw-milk sites are often the
// longest paragraph on the page).
const BOILERPLATE_TEXT_RE =
  /interstate commerce|evaluated by the (fda|food and drug)|disclaimer|liabilit|warrant(y|ies)|indemnif|hold harmless|\bingredients\s*:/i;

// Product-label / legal copy that shouldn't become landing-page prose:
// matches the boilerplate patterns or paragraphs that are mostly SHOUTING
// (ingredient panels, compliance notices).
function isBoilerplateText(text: string): boolean {
  if (BOILERPLATE_TEXT_RE.test(text)) return true;
  // Product-label lines like "Sweet Cream | 4.85 oz" aren't prose.
  if (/\|\s*\d+(\.\d+)?\s*(oz|lb|lbs|g|kg|ml|l|gal|ct|pack)\b/i.test(text))
    return true;
  const letters = text.replace(/[^a-zA-Z]/g, "");
  if (letters.length >= 40) {
    const upper = letters.replace(/[^A-Z]/g, "").length;
    if (upper / letters.length > 0.6) return true;
  }
  return false;
}

function extractAboutText(html: string): string | undefined {
  // Prefer a paragraph under an "about"-style heading; otherwise fall back to
  // the longest real paragraph — skipping legal/nav/cookie boilerplate either
  // way so a disclaimer can't become the shop's about copy.
  const cleaned = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  const tokenRe =
    /<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>|<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  let inAbout = false;
  let aboutBest = "";
  let best = "";
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(cleaned)) !== null) {
    if (m[1]) {
      inAbout = ABOUT_HEADING_RE.test(cleanInlineText(m[2] || ""));
      continue;
    }
    const text = cleanInlineText(m[3] || "");
    if (text.length < 40 || text.length > 1200) continue;
    if (JUNK_TEXT_RE.test(text) || isBoilerplateText(text)) continue;
    if (inAbout && text.length > aboutBest.length) aboutBest = text;
    if (text.length > best.length) best = text;
  }
  return aboutBest || best || undefined;
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
const MAX_CONTENT_BLOCKS = 6;
const MAX_JSONLD_PRODUCTS = 8;
const MAX_TESTIMONIALS = 6;

// Blank out non-content markup while PRESERVING string offsets (equal-length
// space runs), so positions measured in the cleaned string line up with
// positions measured in the raw HTML (used to order imported sections the way
// the source page orders them).
function stripNonContent(html: string): string {
  const blank = (m: string) => " ".repeat(m.length);
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, blank)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, blank)
    .replace(/<(nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, blank);
}

// Junk we never want to promote into a storefront section image: logos, icons,
// tracking pixels and UI chrome. Matched against the image URL's path plus
// its alt text ONLY — never the whole tag, because lazy-load frameworks put
// words like "loader"/"placeholder" in class names on every real photo
// (Squarespace does), which junk-filtered entire sites' imagery.
const JUNK_IMAGE_RE =
  /logo|icon|favicon|sprite|pixel|tracking|beacon|avatar|badge|emoji|spinner|loader|placeholder|1x1|blank|arrow|chevron|bullet|thumb/i;

// True when the image's own identity (URL path + alt text) marks it as
// chrome/junk rather than page content.
function isJunkImage(url: string, alt: string | undefined): boolean {
  let name = url;
  try {
    name = decodeURIComponent(new URL(url, "https://x.invalid").pathname);
  } catch {
    // keep raw url as the haystack
  }
  return JUNK_IMAGE_RE.test(`${name} ${alt ?? ""}`.toLowerCase());
}

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

// Explicit evidence that the source renders an image edge to edge: a declared
// width of at least 1200px (on the tag or as the largest srcset candidate) or
// a banner/full-width class hint on the <img> itself. Anything without
// evidence imports as a contained image — never guessed full-bleed.
const FULL_BLEED_CLASS_RE = /\b(banner|full[-_]?(?:width|bleed)|hero)\b/i;

function imageIsFullBleed(tag: string): boolean {
  const w = Number(tag.match(/\bwidth=["']?(\d+)/i)?.[1] ?? "");
  if (w >= 1200) return true;
  const srcset =
    tag.match(/\bsrcset=["']([^"']+)["']/i)?.[1] ||
    tag.match(/\bdata-srcset=["']([^"']+)["']/i)?.[1];
  if (srcset) {
    for (const part of srcset.split(",")) {
      const d = part.trim().split(/\s+/)[1]?.toLowerCase();
      if (d?.endsWith("w") && (parseInt(d, 10) || 0) >= 1600) return true;
    }
  }
  const cls = tag.match(/\bclass=["']([^"']*)["']/i)?.[1] || "";
  return FULL_BLEED_CLASS_RE.test(cls);
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
): { url: string; alt?: string; pos?: number; fullBleed?: boolean }[] {
  const tagRe = /<img\b[^>]*>/gi;
  const out: {
    url: string;
    alt?: string;
    pos?: number;
    fullBleed?: boolean;
  }[] = [];
  const seen = new Set<string>(exclude);
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    if (out.length >= MAX_CONTENT_IMAGES) break;
    const tag = m[0];
    const raw = pickImageSrc(tag);
    if (!raw) continue;
    const decoded = decodeEntities(raw);
    if (/^data:/i.test(decoded)) continue;
    const altRaw = tag.match(/\balt=["']([^"']*)["']/i)?.[1];
    const alt = altRaw ? decodeEntities(altRaw) : undefined;
    const absRaw = absolute(decoded, base);
    if (!absRaw) continue;
    if (isJunkImage(absRaw, alt)) continue;
    if (imageAttrTooSmall(tag)) continue;
    if (/\.svg(\?|#|$)/i.test(absRaw)) continue;
    // Upgrade CDN thumbnails to the full-resolution original for best quality.
    const abs = stripImageSizeSuffix(absRaw);
    const key = abs.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      url: abs,
      alt: alt && alt.length > 0 ? alt : undefined,
      pos: m.index,
      ...(imageIsFullBleed(tag) ? { fullBleed: true } : {}),
    });
  }
  return out;
}

// Nearest enclosing inline background-color BEFORE a block's position:
// the last <section>/<div> open tag in the preceding window that declares an
// explicit background(-color) in its style attribute. Only inline styles are
// trusted (stylesheet cascade can't be resolved without a real DOM); white is
// dropped because it's already the default band.
function nearestBandColor(html: string, pos: number): string | undefined {
  const windowStart = Math.max(0, pos - 1500);
  const slice = html.slice(windowStart, pos);
  const re =
    /<(?:section|div)\b[^>]*\bstyle=["'][^"']*background(?:-color)?\s*:\s*([^;"']+)/gi;
  let last: string | undefined;
  let m: RegExpExecArray | null;
  while ((m = re.exec(slice)) !== null) last = m[1];
  if (!last) return undefined;
  const hex = normalizeHexColor(last.trim());
  return hex && hex !== "#ffffff" ? hex : undefined;
}

/**
 * Pull ordered heading + paragraph blocks from the page body so the site's own
 * sections of copy become extra storefront `text` sections. Only keeps blocks
 * that have BOTH a real heading and a substantial paragraph, so we never
 * fabricate headings or ship nav/cookie boilerplate.
 */
function extractContentBlocks(html: string): {
  heading: string;
  body: string;
  pos?: number;
  backgroundColor?: string;
}[] {
  const cleaned = stripNonContent(html);

  const tokenRe =
    /<(h[1-4])\b[^>]*>([\s\S]*?)<\/\1>|<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  const blocks: {
    heading: string;
    body: string;
    pos?: number;
    backgroundColor?: string;
  }[] = [];
  let heading: string | null = null;
  let headingPos = 0;
  let body: string[] = [];

  const flush = () => {
    if (heading) {
      const text = body.join("\n\n").trim();
      if (text.length >= 40) {
        const backgroundColor = nearestBandColor(cleaned, headingPos);
        blocks.push({
          heading,
          body: text.slice(0, 800),
          pos: headingPos,
          ...(backgroundColor ? { backgroundColor } : {}),
        });
      }
    }
    heading = null;
    body = [];
  };

  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(cleaned)) !== null) {
    if (match[1]) {
      flush();
      const h = cleanInlineText(match[2] || "");
      // Quote-leading headings are testimonial pull-quotes, not section
      // headings — they're extracted separately by extractTestimonials.
      heading =
        h.length >= 3 &&
        h.length <= 80 &&
        !/^["'\u201c\u201d\u2018\u2019\u00ab]/.test(h) &&
        !JUNK_TEXT_RE.test(h)
          ? h
          : null;
      headingPos = match.index;
    } else if (heading) {
      const p = cleanInlineText(match[3] || "");
      if (p.length >= 20 && !JUNK_TEXT_RE.test(p) && !isBoilerplateText(p))
        body.push(p);
    }
  }
  flush();

  return blocks.slice(0, MAX_CONTENT_BLOCKS);
}

// Headings that mark a customer-quotes region of the page.
const TESTIMONIAL_HEADING_RE =
  /review|testimonial|customers? say|what (people|our|they)|love|feedback/i;

/**
 * Pull customer pull-quotes from the page: heading/blockquote elements whose
 * text STARTS with a quote character (the way review walls are typically
 * marked up). Requires at least two quotes so a lone quoted heading can't
 * fabricate a reviews section. The surrounding quote marks are stripped —
 * the storefront testimonial renderer adds its own.
 */
function extractTestimonials(html: string):
  | {
      heading?: string;
      quotes: { quote: string; author?: string }[];
      pos?: number;
    }
  | undefined {
  const cleaned = stripNonContent(html);
  const tokenRe = /<(h[1-6]|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  const quotes: { quote: string; author?: string }[] = [];
  const seen = new Set<string>();
  let heading: string | undefined;
  let lastHeading: string | undefined;
  let firstPos: number | undefined;
  let m: RegExpExecArray | null;
  while (
    (m = tokenRe.exec(cleaned)) !== null &&
    quotes.length < MAX_TESTIMONIALS
  ) {
    const text = cleanInlineText(m[2] || "");
    if (!text) continue;
    const isQuote =
      /^["'\u201c\u2018\u00ab]/.test(text) ||
      m[1]!.toLowerCase() === "blockquote";
    if (!isQuote) {
      if (/^h[1-3]$/i.test(m[1]!) && text.length <= 80) lastHeading = text;
      continue;
    }
    // Trailing attribution ("… ” —Alice") becomes the author; requires the
    // closing quote before the dash so a dash INSIDE a quote never splits it.
    let quoteText = text;
    let author: string | undefined;
    const attribution = text.match(
      /^(.*["\u201d\u2019\u00bb])\s*[—–-]\s*([^"\u201c\u201d]{2,60})$/s
    );
    if (attribution) {
      quoteText = attribution[1]!;
      author = attribution[2]!.trim();
    }
    const stripped = quoteText
      .replace(/^["'\u201c\u201d\u2018\u2019\u00ab\s]+/, "")
      .replace(/["'\u201c\u201d\u2018\u2019\u00bb\s]+$/, "")
      .trim();
    if (stripped.length < 20 || stripped.length > 400) continue;
    if (JUNK_TEXT_RE.test(stripped) || isBoilerplateText(stripped)) continue;
    const key = stripped.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (quotes.length === 0) {
      firstPos = m.index;
      if (lastHeading && TESTIMONIAL_HEADING_RE.test(lastHeading))
        heading = lastHeading;
    }
    quotes.push({ quote: stripped, author });
  }
  if (quotes.length < 2) return undefined;
  return { heading, quotes, pos: firstPos };
}

// Detect an explicitly DARK site header so the imported nav can match it.
// Conservative: only trusts the platform's own theme attribute
// (data-section-theme="black|black-bold|dark", Squarespace) or an explicit
// dark inline background-color on the <header>/<nav> open tag. CSS variables
// are deliberately NOT parsed — they routinely contradict the rendered header.
function extractHeaderTheme(html: string): "dark" | undefined {
  const tag =
    html.match(/<header\b[^>]*>/i)?.[0] || html.match(/<nav\b[^>]*>/i)?.[0];
  if (!tag) return undefined;
  const theme = tag.match(/\bdata-section-theme=["']([^"']*)["']/i)?.[1];
  if (theme && /\b(black|dark)\b/i.test(theme)) return "dark";
  const style = tag.match(/\bstyle=["']([^"']*)["']/i)?.[1];
  const bg = style?.match(/background(?:-color)?\s*:\s*([^;]+)/i)?.[1];
  if (bg) {
    const hex = normalizeHexColor(bg.trim());
    if (hex) {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      if ((r * 299 + g * 587 + b * 114) / 1000 < 90) return "dark";
    }
  }
  return undefined;
}

// Class/id hints that mark a page's hero/banner region, plus exclusions for
// the false-positive "banner" uses (cookie banners, announcement bars).
const HERO_HINT_RE = /\b(hero|banner|masthead|jumbotron|slideshow)\b/i;
const HERO_EXCLUDE_RE =
  /cookie|consent|announc|promo[-_]?bar|top[-_]?bar|alert|gdpr|popup|modal/i;
const HERO_SLICE_CHARS = 15000;
const MAX_HERO_CANDIDATES = 6;

function heroImageFromSlice(slice: string, base: URL): string | undefined {
  const imgTags = slice.match(/<img\b[^>]*>/gi) || [];
  for (const tag of imgTags) {
    const raw = pickImageSrc(tag);
    if (!raw) continue;
    const decoded = decodeEntities(raw);
    if (/^data:/i.test(decoded)) continue;
    const alt = tag.match(/\balt=["']([^"']*)["']/i)?.[1] || "";
    const abs = absolute(decoded, base);
    if (!abs || /\.svg(\?|#|$)/i.test(abs)) continue;
    if (isJunkImage(abs, alt)) continue;
    if (imageAttrTooSmall(tag)) continue;
    return stripImageSizeSuffix(abs);
  }
  // CSS background heroes: inline style="background-image:url(...)".
  const bg = slice.match(
    /background(?:-image)?\s*:[^;"']*url\(\s*(?:&quot;|["'])?([^"')]+?)(?:&quot;|["'])?\s*\)/i
  )?.[1];
  if (bg) {
    const decoded = decodeEntities(bg.trim());
    if (!/^data:/i.test(decoded)) {
      const abs = absolute(decoded, base);
      if (abs && !/\.svg(\?|#|$)/i.test(abs)) return stripImageSizeSuffix(abs);
    }
  }
  return undefined;
}

/**
 * Parse the page's hero/banner region deterministically: find the first
 * element whose class/id says "hero", and pull its feature image plus any real
 * text overlay (first h1/h2 + the paragraph after it) from INSIDE that region.
 * When the source hero has no DOM text (text baked into the image), heading /
 * subheading stay undefined so the imported banner is a clean image.
 */
function extractHeroRegion(
  html: string,
  base: URL
): { image?: string; heading?: string; subheading?: string } | undefined {
  const openTagRe = /<(section|div|header|main|figure|aside)\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  let candidates = 0;
  while (
    (match = openTagRe.exec(html)) !== null &&
    candidates < MAX_HERO_CANDIDATES
  ) {
    const tag = match[0];
    const attrs =
      (tag.match(/\bclass=["']([^"']*)["']/i)?.[1] || "") +
      " " +
      (tag.match(/\bid=["']([^"']*)["']/i)?.[1] || "");
    if (!HERO_HINT_RE.test(attrs) || HERO_EXCLUDE_RE.test(attrs)) continue;
    candidates++;

    const slice = html.slice(match.index, match.index + HERO_SLICE_CHARS);
    const image = heroImageFromSlice(slice, base);

    const headingMatch =
      slice.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) ||
      slice.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i);
    let heading: string | undefined;
    let subheading: string | undefined;
    if (headingMatch) {
      const h = cleanInlineText(headingMatch[1] || "");
      if (h.length >= 3 && h.length <= 120 && !JUNK_TEXT_RE.test(h)) {
        heading = h;
        const after = slice.slice(
          (headingMatch.index ?? 0) + headingMatch[0].length
        );
        const p = after.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
        if (p) {
          const text = cleanInlineText(p[1] || "");
          if (
            text.length >= 10 &&
            text.length <= 300 &&
            !JUNK_TEXT_RE.test(text)
          ) {
            subheading = text;
          }
        }
      }
    }

    if (image || heading) return { image, heading, subheading };
  }
  return undefined;
}

const MAX_VIDEOS = 3;

/**
 * Deterministically collect YouTube video URLs from the page (iframe embeds,
 * shorts/watch/youtu.be links), deduped by video id and canonicalized to
 * watch URLs that the storefront social-posts embed resolver understands.
 */
function extractVideoUrls(html: string): string[] {
  const re =
    /(?:youtube(?:-nocookie)?\.com\/(?:embed\/|shorts\/|live\/|v\/|watch\?(?:[^"'\s>]*&(?:amp;)?)?v=)|youtu\.be\/)([A-Za-z0-9_-]{6,})/gi;
  const ids: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && ids.length < MAX_VIDEOS) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids.map((id) => `https://www.youtube.com/watch?v=${id}`);
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

// Repeated HTML product-card detection for pages without JSON-LD. A "card" is
// an element whose class says product/collection-item etc. containing an image,
// a short title, and a visible price. Requires at least 3 cards so a lone
// "product" div can't fabricate a product grid; capped at MAX_JSONLD_PRODUCTS.
const PRODUCT_CARD_CLASS_RE =
  /\b(product[-_]?(card|item|tile|block|grid[-_]?item)?|grid__item|collection[-_]?item|shop[-_]?item|item[-_]?card)\b/i;
const CARD_SLICE_CHARS = 3000;
const MAX_PRODUCT_CARD_CANDIDATES = 60;

const PRICE_SYMBOL_CURRENCY: Record<string, string> = {
  $: "USD",
  "€": "EUR",
  "£": "GBP",
};

function parseCardPrice(
  slice: string
): { price: number; currency: string } | undefined {
  const text = cleanInlineText(slice);
  const sym = text.match(/([$€£])\s?(\d{1,6}(?:[.,]\d{2})?)/);
  if (sym) {
    const price = parseFloat(sym[2]!.replace(",", "."));
    if (Number.isFinite(price) && price > 0)
      return { price, currency: PRICE_SYMBOL_CURRENCY[sym[1]!] || "USD" };
  }
  const code = text.match(/(\d{1,6}(?:[.,]\d{2})?)\s?(USD|EUR|GBP|CAD|AUD)\b/i);
  if (code) {
    const price = parseFloat(code[1]!.replace(",", "."));
    if (Number.isFinite(price) && price > 0)
      return { price, currency: code[2]!.toUpperCase() };
  }
  return undefined;
}

function cardTitle(slice: string, imgAlt?: string): string | undefined {
  const heading =
    slice.match(/<h[2-6]\b[^>]*>([\s\S]*?)<\/h[2-6]>/i)?.[1] ||
    slice.match(
      /<a\b[^>]*(?:class=["'][^"']*(?:title|name)[^"']*["'])[^>]*>([\s\S]*?)<\/a>/i
    )?.[1];
  const candidates = [heading, imgAlt];
  for (const raw of candidates) {
    if (!raw) continue;
    const text = cleanInlineText(raw);
    if (
      text.length >= 2 &&
      text.length <= 120 &&
      !JUNK_TEXT_RE.test(text) &&
      !/^[$€£]?\s?\d/.test(text)
    )
      return text;
  }
  return undefined;
}

function extractHtmlProductCards(
  html: string,
  base: URL
): {
  products: {
    title: string;
    image?: string;
    price?: number;
    currency?: string;
  }[];
  pos?: number;
} {
  const cleaned = stripNonContent(html);
  const openTagRe = /<(li|div|article)\b[^>]*>/gi;
  const products: {
    title: string;
    image?: string;
    price?: number;
    currency?: string;
  }[] = [];
  const seenCards = new Set<string>();
  let firstPos: number | undefined;
  let candidates = 0;
  let m: RegExpExecArray | null;
  while (
    (m = openTagRe.exec(cleaned)) !== null &&
    products.length < MAX_JSONLD_PRODUCTS &&
    candidates < MAX_PRODUCT_CARD_CANDIDATES
  ) {
    const tag = m[0];
    const cls =
      (tag.match(/\bclass=["']([^"']*)["']/i)?.[1] || "") +
      " " +
      (tag.match(/\bid=["']([^"']*)["']/i)?.[1] || "");
    if (!PRODUCT_CARD_CLASS_RE.test(cls)) continue;
    candidates++;

    const slice = cleaned.slice(m.index, m.index + CARD_SLICE_CHARS);
    const imgTag = slice.match(/<img\b[^>]*>/i)?.[0];
    if (!imgTag) continue;
    const rawSrc = pickImageSrc(imgTag);
    const alt = imgTag.match(/\balt=["']([^"']*)["']/i)?.[1];
    const image = rawSrc ? absolute(decodeEntities(rawSrc), base) : undefined;
    if (!image || /^data:/i.test(image) || /\.svg(\?|#|$)/i.test(image))
      continue;

    const title = cardTitle(slice, alt ? decodeEntities(alt) : undefined);
    if (!title) continue;
    const priced = parseCardPrice(slice);
    if (!priced) continue;

    // Nested product-classed wrappers around the same card produce the same
    // title+image pair — dedup on the pair (not either alone, so distinct
    // products sharing a placeholder photo or a repeated name survive).
    const key = `${title.toLowerCase()}|${image.toLowerCase()}`;
    if (seenCards.has(key)) continue;
    seenCards.add(key);
    if (firstPos === undefined) firstPos = m.index;
    products.push({
      title: title.slice(0, 120),
      image: stripImageSizeSuffix(image),
      price: priced.price,
      currency: priced.currency,
    });
  }
  // Fewer than 3 matching blocks isn't a product grid — don't fabricate one.
  if (products.length < 3) return { products: [] };
  return { products, pos: firstPos };
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

  // A few linked stylesheets. Shared PLATFORM stylesheets (Squarespace
  // universal/commerce CSS + component definitions + versioned template CSS
  // ("?nocustom=true" — its dominant colors are editor chrome, not the site),
  // Wix platform CSS, Shopify platform bundles) carry the platform's colors,
  // not this site's brand — they polluted palettes with identical colors
  // across unrelated sites. Site-specific CSS (same-origin, Squarespace
  // /static/custom-css/, Shopify /s/files, Google Fonts) still passes.
  const PLATFORM_STYLESHEET_RE =
    /\/\/(assets\.squarespace\.com|[^/]*\.sqspcdn\.com|[^/]*\.parastorage\.com)\/|\/\/cdn\.shopify\.com\/shopifycloud\/|\/\/static1\.squarespace\.com\/static\/(versioned-site-css|vta)\//i;
  const sheetHrefs = extractStylesheetHrefs(html)
    .map((href) => absolute(href, base))
    .filter((u): u is string => !!u && !PLATFORM_STYLESHEET_RE.test(u))
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
  const hero = extractHeroRegion(html, base);
  const videos = extractVideoUrls(html);

  // Images already spoken for elsewhere shouldn't be repeated as content
  // sections.
  const usedImageUrls = new Set<string>();
  for (const u of [ogImage, logoUrl, faviconUrl, hero?.image]) {
    if (u) usedImageUrls.add(u.toLowerCase());
  }
  const images = extractContentImages(html, base, usedImageUrls);
  const contentBlocks = extractContentBlocks(html);
  // JSON-LD is authoritative when present; repeated HTML product-card markup
  // is the fallback for pages without structured data. The HTML scan also
  // supplies the grid's position so the imported products section can sit
  // where the source page puts it.
  const jsonLdProducts = extractJsonLdProducts(html, base);
  const htmlCards = extractHtmlProductCards(html, base);
  const products =
    jsonLdProducts.length > 0 ? jsonLdProducts : htmlCards.products;
  const productsPos = htmlCards.pos;
  const navLayout = detectNavLayout(html);
  const headerTheme = extractHeaderTheme(html);
  const testimonials = extractTestimonials(html);

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
    productsPos,
    navLayout,
    hero,
    videos: videos.length > 0 ? videos : undefined,
    headerTheme,
    testimonials,
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
