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
