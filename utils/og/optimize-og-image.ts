/**
 * Rewrite an absolute og:image URL so crawlers/social-preview bots fetch a
 * compressed, right-sized copy from /api/og-image instead of the (often
 * multi-MB) original uploaded by the seller.
 *
 * Applied at the DynamicHead render seam so every stall + custom-domain route
 * (SSR ogMeta and client-side fallbacks alike) emits the optimized URL.
 *
 * Only absolute http(s) URLs are wrapped: relative paths are absolute-ized by
 * the caller first, and data:/blob: URLs can't be proxied. Already-wrapped
 * URLs pass through unchanged (client-side re-renders stay idempotent).
 */
export function toOptimizedOgImageUrl(
  absoluteImageUrl: string,
  origin: string
): string {
  if (!absoluteImageUrl) return absoluteImageUrl;
  if (!/^https?:\/\//i.test(absoluteImageUrl)) return absoluteImageUrl;
  if (absoluteImageUrl.includes("/api/og-image")) return absoluteImageUrl;
  const base = origin.replace(/\/+$/, "");
  if (!base) return absoluteImageUrl;
  return `${base}/api/og-image?url=${encodeURIComponent(absoluteImageUrl)}`;
}

/**
 * Pick the origin the proxied og:image URL should live on. On seller custom
 * domains this must be the seller's own domain (domain purity) — the SSR
 * store URL already canonicalizes to it, so its origin is the server-safe
 * source for the initial HTML. Client-side without an SSR URL we fall back to
 * the live origin; anything else gets the platform base. Never derived from
 * the request Host header.
 */
export function resolveOgImageOrigin(
  ssrStoreUrl: string | undefined,
  isCustomDomain: boolean,
  fallbackOrigin = "https://milk.market"
): string {
  if (ssrStoreUrl) {
    try {
      const { origin } = new URL(ssrStoreUrl);
      if (origin && origin !== "null") return origin;
    } catch {
      // Unparseable — fall through to the client/platform fallbacks.
    }
  }
  if (isCustomDomain && typeof window !== "undefined") {
    return window.location.origin;
  }
  return fallbackOrigin;
}
