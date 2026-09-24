import { sanitizeUrl } from "@braintree/sanitize-url";
import {
  StorefrontConfig,
  StorefrontFooter,
  StorefrontNavLink,
  StorefrontPage,
  StorefrontSection,
  StorefrontSocialLink,
} from "@/utils/types/types";
import { POLICY_SLUGS } from "@/utils/storefront-policies";

const BLOCKED_URL = "about:blank";
const ABSOLUTE_SCHEME_RE = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
const EXTERNAL_HREF_RE = /^(https?:|mailto:|tel:)/i;
const SECTION_CTA_SCHEME_RE = /^https?:/i;
const BLOCKED_SCHEME_RE = /^(javascript|vbscript|data|file|blob):/i;
const STRIP_INVISIBLE_RE =
  /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\uFEFF\s]/g;

function stripInvisible(value: string): string {
  return value.replace(STRIP_INVISIBLE_RE, "");
}

function hasBlockedScheme(value: string): boolean {
  return BLOCKED_SCHEME_RE.test(stripInvisible(value));
}

function safeSegment(segment: string): string {
  if (!segment || segment === "." || segment === "..") return "";
  try {
    return encodeURIComponent(decodeURIComponent(segment));
  } catch {
    return encodeURIComponent(segment);
  }
}

function normalizeRelativeShopPath(value: string, shopSlug: string): string {
  const trimmed = value.trim();
  const parts = trimmed.split(/[?#]/);
  const pathPart = parts[0] ?? "";
  const suffix = parts.length > 1 ? trimmed.slice(pathPart.length) : "";
  let segments = pathPart
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
      segments = segments.slice(2);
    }
  }
  const safePath = segments.join("/");
  const base = shopSlug ? `/stall/${shopSlug}` : "";
  if (!safePath) return base || "/";
  return `${base}/${safePath}${suffix}`;
}

export function sanitizeStorefrontHref(
  value: string | undefined,
  fallback: string
): string {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  if (trimmed.startsWith("#")) return trimmed;
  if (hasBlockedScheme(trimmed)) return fallback;

  const sanitized = sanitizeUrl(trimmed);
  if (!sanitized || sanitized === BLOCKED_URL) return fallback;
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
  const cleaned = stripInvisible(trimmed);
  if (!SECTION_CTA_SCHEME_RE.test(cleaned)) return fallback;
  return sanitizeStorefrontHref(trimmed, fallback);
}

export function sanitizeStorefrontSocialLink(
  value: string | undefined,
  fallback = "#"
): string {
  return sanitizeStorefrontHref(value, fallback);
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
  if (ABSOLUTE_SCHEME_RE.test(stripInvisible(trimmed))) {
    return sanitizeStorefrontHref(trimmed, safeFallback);
  }

  return normalizeRelativeShopPath(trimmed, shopSlug);
}

// Built-in storefront subpage routes, shared by the page editor (custom pages
// can't take these slugs) and the SSR subpage validator. UNGATED routes render
// for every visitor; GATED routes render only when the seller enabled the
// matching storefront flag (the renderer shows its own Not Found when off, so
// the SSR validator must gate them the same way or they index as soft-404s).
export const STOREFRONT_BUILTIN_SUBPAGES: ReadonlySet<string> = new Set([
  "shop",
  "orders",
  "blog",
  "my-listings",
  "order-confirmation",
]);
export const STOREFRONT_GATED_SUBPAGES = {
  wallet: "showWalletPage",
  community: "showCommunityPage",
} as const;
// Policy slugs are reserved too: the policy render branch runs before custom
// pages, so a page named "return-policy" could never display.
export const RESERVED_PAGE_SLUGS: ReadonlySet<string> = new Set([
  ...STOREFRONT_BUILTIN_SUBPAGES,
  ...Object.keys(STOREFRONT_GATED_SUBPAGES),
  ...Object.values(POLICY_SLUGS),
]);

export function isExternalStorefrontHref(href: string): boolean {
  return EXTERNAL_HREF_RE.test(href);
}

/**
 * Append a nav link for every custom page that isn't already linked. Stored
 * navLinks are empty on many existing storefronts (historical save paths
 * dropped them), so without this those sellers' pages exist but are
 * unreachable from the nav. Links the seller already configured win; pages
 * they deliberately deleted are gone from pages[] and don't come back.
 */
export function injectPageNavLinks(
  links: StorefrontNavLink[],
  pages: { slug: string; title?: string }[] | undefined,
  shopSlug: string
): StorefrontNavLink[] {
  if (!pages || pages.length === 0) return links;
  const stallPrefix = shopSlug ? `stall/${shopSlug}/` : "";
  const result = [...links];
  for (const page of pages) {
    if (!page?.slug) continue;
    const linked = result.some((l) => {
      if (!l.isPage) return false;
      const h = (l.href || "").replace(/^\/+/, "");
      return h === page.slug || h === `${stallPrefix}${page.slug}`;
    });
    if (!linked) {
      result.push({
        label: page.title || page.slug,
        href: page.slug,
        isPage: true,
      });
    }
  }
  return result;
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
