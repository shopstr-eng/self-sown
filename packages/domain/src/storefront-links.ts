// Storefront link safety, shared by the web save path and the mobile design
// editors. Storefront configs ride permissionless Nostr events, so every
// buyer-rendered href must be scheme-validated before it is persisted (the
// renderers sanitize again at render time). This is a dependency-free port of
// the original web sanitizer (utils/storefront-links.ts, which delegates
// here); the @braintree/sanitize-url behavior it relied on is reproduced
// inline so this package stays dependency-free for mobile.
import type {
  StorefrontConfig,
  StorefrontFooter,
  StorefrontNavLink,
  StorefrontPage,
  StorefrontSection,
  StorefrontSocialLink,
} from "./storefront";

const ABSOLUTE_SCHEME_RE = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
const SECTION_CTA_SCHEME_RE = /^https?:/i;
const BLOCKED_SCHEME_RE = /^(javascript|vbscript|data|file|blob):/i;
const ALLOWED_ABSOLUTE_PROTOCOLS = new Set([
  "http:",
  "https:",
  "mailto:",
  "tel:",
]);
const STRIP_INVISIBLE_RE =
  /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\uFEFF\s]/g;

const NAMED_HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  tab: "\t",
  colon: ":",
  sol: "/",
};

function stripInvisible(value: string): string {
  return value.replace(STRIP_INVISIBLE_RE, "");
}

// Mirrors the entity-decoding @braintree/sanitize-url applies before scheme
// detection, so "java&#115;cript:" can't smuggle a blocked scheme past it.
function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);?/g, (_match, code: string) => {
      const codePoint = Number.parseInt(code, 10);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff)
        return "";
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return "";
      }
    })
    .replace(/&#x([0-9a-f]+);?/gi, (_match, hex: string) => {
      const codePoint = Number.parseInt(hex, 16);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff)
        return "";
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return "";
      }
    })
    .replace(
      /&([a-z]+);?/gi,
      (match, name: string) => NAMED_HTML_ENTITIES[name.toLowerCase()] ?? match
    );
}

function hasBlockedScheme(value: string): boolean {
  return BLOCKED_SCHEME_RE.test(stripInvisible(decodeHtmlEntities(value)));
}

// Self-contained sanitizeUrl equivalent: anchors and relative URLs pass
// through; absolute URLs must parse with an allowed protocol; anything with a
// blocked scheme (including entity-encoded) is rejected.
function sanitizeUrlLike(value: string): string | null {
  const trimmed = decodeHtmlEntities(value).trim();
  if (!trimmed) return null;
  if (hasBlockedScheme(trimmed)) return null;
  if (ABSOLUTE_SCHEME_RE.test(stripInvisible(trimmed))) {
    try {
      const url = new URL(trimmed);
      if (!ALLOWED_ABSOLUTE_PROTOCOLS.has(url.protocol)) return null;
      return trimmed;
    } catch {
      return null;
    }
  }
  return trimmed;
}

export function sanitizeStorefrontHref(
  value: string | undefined,
  fallback: string
): string {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  if (trimmed.startsWith("#")) return trimmed;
  if (hasBlockedScheme(trimmed)) return fallback;

  const sanitized = sanitizeUrlLike(trimmed);
  if (!sanitized) return fallback;
  if (hasBlockedScheme(sanitized)) return fallback;

  return sanitized;
}

export function sanitizeStorefrontSectionLink(
  value: string | undefined,
  fallback = "#products"
): string {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  if (trimmed.startsWith("#")) return trimmed;
  if (trimmed.startsWith("/")) {
    const sanitized = sanitizeStorefrontHref(trimmed, fallback);
    return sanitized.startsWith("/") ? sanitized : fallback;
  }
  const cleaned = stripInvisible(decodeHtmlEntities(trimmed));
  if (!SECTION_CTA_SCHEME_RE.test(cleaned)) return fallback;
  return sanitizeStorefrontHref(trimmed, fallback);
}

export function sanitizeStorefrontSocialLink(
  value: string | undefined,
  fallback = "#"
): string {
  return sanitizeStorefrontHref(value, fallback);
}

function safeSegment(segment: string): string {
  if (!segment || segment === "." || segment === "..") return "";
  try {
    return encodeURIComponent(decodeURIComponent(segment));
  } catch {
    return encodeURIComponent(segment);
  }
}

export function normalizeRelativeShopPath(
  value: string,
  shopSlug: string
): string {
  const trimmed = value.trim();
  const parts = trimmed.split(/[?#]/);
  const pathPart = parts[0] ?? "";
  const suffix = parts.length > 1 ? trimmed.slice(pathPart.length) : "";
  const segments = pathPart
    .replace(/^\/+/, "")
    .split("/")
    .map(safeSegment)
    .filter(Boolean);
  // Idempotent: persisted hrefs are already prefixed with /stall/<shopSlug>
  // (publish sanitizes, render sanitizes again) — strip one leading copy so
  // re-sanitizing a stored href doesn't double-prefix it into a 404.
  if (shopSlug) {
    const slugSeg = safeSegment(shopSlug);
    if (segments[0] === "stall" && segments[1] === slugSeg) {
      segments.splice(0, 2);
    }
  }
  const safePath = segments.join("/");
  const base = shopSlug ? `/stall/${shopSlug}` : "";
  if (!safePath) return base || "/";
  return `${base}/${safePath}${suffix}`;
}

export function sanitizeStorefrontNavHref(
  link: StorefrontNavLink,
  shopSlug: string,
  fallback?: string
): string {
  const safeFallback = fallback || (shopSlug ? `/stall/${shopSlug}` : "/");
  const trimmed = link.href?.trim();

  if (!trimmed) return safeFallback;
  if (link.isPage) return normalizeRelativeShopPath(trimmed, shopSlug);
  if (trimmed.startsWith("#")) return trimmed;
  if (trimmed.startsWith("/")) {
    if (hasBlockedScheme(trimmed)) return safeFallback;
    return sanitizeStorefrontHref(trimmed, safeFallback);
  }
  if (ABSOLUTE_SCHEME_RE.test(stripInvisible(decodeHtmlEntities(trimmed)))) {
    return sanitizeStorefrontHref(trimmed, safeFallback);
  }

  return normalizeRelativeShopPath(trimmed, shopSlug);
}

function sanitizeSection(section: StorefrontSection): StorefrontSection {
  let updated = section;

  if (updated.ctaLink) {
    updated = {
      ...updated,
      ctaLink: sanitizeStorefrontSectionLink(updated.ctaLink),
    };
  }

  if (updated.buttons && updated.buttons.length > 0) {
    updated = {
      ...updated,
      buttons: updated.buttons.map((btn) => ({
        ...btn,
        ...(btn.href ? { href: sanitizeStorefrontSectionLink(btn.href) } : {}),
      })),
    };
  }

  if (updated.socialPosts && updated.socialPosts.length > 0) {
    updated = {
      ...updated,
      socialPosts: updated.socialPosts.map((post) => ({
        ...post,
        url: sanitizeStorefrontSocialLink(post.url),
      })),
    };
  }

  if (updated.bannerSlides && updated.bannerSlides.length > 0) {
    updated = {
      ...updated,
      bannerSlides: updated.bannerSlides.map((slide) => ({
        ...slide,
        ...(slide.ctaLink
          ? { ctaLink: sanitizeStorefrontSectionLink(slide.ctaLink) }
          : {}),
      })),
    };
  }

  return updated;
}

function sanitizePage(page: StorefrontPage): StorefrontPage {
  return {
    ...page,
    sections: page.sections.map(sanitizeSection),
  };
}

function sanitizeFooter(
  footer: StorefrontFooter,
  shopSlug: string
): StorefrontFooter {
  return {
    ...footer,
    socialLinks: footer.socialLinks?.map(
      (link): StorefrontSocialLink => ({
        ...link,
        url: sanitizeStorefrontSocialLink(link.url),
      })
    ),
    navLinks: footer.navLinks?.map(
      (link): StorefrontNavLink => ({
        ...link,
        href: sanitizeStorefrontNavHref(link, shopSlug),
      })
    ),
  };
}

export function sanitizeStorefrontConfigLinks(
  storefront: StorefrontConfig
): StorefrontConfig {
  const shopSlug = storefront.shopSlug || "";

  return {
    ...storefront,
    sections: storefront.sections?.map(sanitizeSection),
    pages: storefront.pages?.map(sanitizePage),
    blogPage: storefront.blogPage
      ? {
          ...storefront.blogPage,
          sections: storefront.blogPage.sections?.map(sanitizeSection),
        }
      : storefront.blogPage,
    navLinks: storefront.navLinks?.map(
      (link): StorefrontNavLink => ({
        ...link,
        href: sanitizeStorefrontNavHref(link, shopSlug),
      })
    ),
    footer: storefront.footer
      ? sanitizeFooter(storefront.footer, shopSlug)
      : storefront.footer,
  };
}
