import {
  sanitizeStorefrontHref,
  type StorefrontNavLink,
} from "@self-sown/domain";
import { POLICY_SLUGS } from "@/utils/storefront-policies";

// The sanitize* chain (sanitizeStorefrontHref, sanitizeStorefrontSectionLink,
// sanitizeStorefrontSocialLink, sanitizeStorefrontNavHref,
// normalizeRelativeShopPath, sanitizeStorefrontConfigLinks) lives in
// @self-sown/domain so the web save path and the mobile design editors run
// the exact same code; this module re-exports it and keeps the web-only
// helpers below.
export {
  sanitizeStorefrontHref,
  sanitizeStorefrontSectionLink,
  sanitizeStorefrontSocialLink,
  sanitizeStorefrontNavHref,
  normalizeRelativeShopPath,
  sanitizeStorefrontConfigLinks,
} from "@self-sown/domain";

const EXTERNAL_HREF_RE = /^(https?:|mailto:|tel:)/i;

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

// NIP-05 address shape (name@domain): the local part per spec plus a hostname.
// The footer's address is assembled from /.well-known/nostr.json keys and
// window.location.hostname; this regex is the parse-time validation before
// either becomes part of an href (see listing-tag URL sanitization rules).
const NIP05_ADDRESS_RE = /^[a-z0-9._+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*$/i;

/**
 * Build a https profile-viewer URL (njump.me, zap-capable) for a NIP-05
 * address so buyers can open/zap the seller in one click. Returns null for
 * anything that isn't a well-formed address; the result is also run through
 * the same sanitizeUrl pipeline as other buyer-facing storefront hrefs.
 */
export function nip05ProfileUrl(address: string | undefined): string | null {
  const trimmed = address?.trim();
  if (!trimmed || !NIP05_ADDRESS_RE.test(trimmed)) return null;
  const sanitized = sanitizeStorefrontHref(
    `https://njump.me/${encodeURIComponent(trimmed)}`,
    ""
  );
  return sanitized || null;
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
