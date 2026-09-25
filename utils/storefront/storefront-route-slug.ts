// Extract the current shop slug from router state. The user-visible URL
// (asPath) is authoritative ONLY when it is itself a /stall/** URL: on seller
// custom domains the proxy rewrites public paths ("/blog/post") to internal
// /stall/<shop>/** pages, so router.pathname starts with /stall/ while
// asPath's first segment ("blog") is NOT a shop slug. Custom-domain visits
// fall back to the SSR-verified shop slug.
export function resolveStorefrontRouteSlug(opts: {
  asPath: string | null | undefined;
  isCustomDomainVisit: boolean;
  ssrShopSlug: string | null | undefined;
}): string | null {
  const asPath = opts.asPath ?? "";
  if (asPath.startsWith("/stall/")) {
    const segment = asPath.replace(/^\/stall\//, "").split("/")[0] ?? "";
    const slug = (segment.split("?")[0] ?? "").trim();
    return slug ? decodeURIComponent(slug) : null;
  }
  if (opts.isCustomDomainVisit && opts.ssrShopSlug) return opts.ssrShopSlug;
  return null;
}
