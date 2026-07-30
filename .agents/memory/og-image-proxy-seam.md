---
name: OG image proxy seam
description: Crawler-facing og:image URLs are compressed via /api/og-image, wrapped at the DynamicHead seam; route must stay in the custom-domain proxy allowlist; public image-proxy hardening pattern.
---

Crawler-facing `og:image`/`twitter:image` on storefront surfaces is served through `/api/og-image`, an optimizing proxy (safeFetch → streamed 10MB cap → sharp resize to ≤1200×630 → JPEG q82/webp, LRU + inflight dedup, 307 redirect to the original on any failure). Wrapping happens at ONE seam: `toOptimizedOgImageUrl(metaTags.image, canonicalOrigin)` in `components/dynamic-meta-head.tsx`, which covers SSR ogMeta and every client fallback branch.

**Why:** Seller OG/banner/product images live on arbitrary third-party hosts and are often multi-MB; social cards were slow/sharp-less. Crawlers fetch the proxy URL directly, so the route must be abuse-safe on its own (rate limit, SSRF guard, per-read deadline race — a stalled upstream `read()` must not hold a worker).

**How to apply:**

- Any NEW storefront OG-image surface must emit its URL through `toOptimizedOgImageUrl` (idempotent; absolute http(s) only), not a raw upload URL.
- The route's origin is the page's canonical origin, so on custom domains the crawler fetches it through the seller's domain: `/api/og-image` MUST stay in `CUSTOM_DOMAIN_API_ALLOWLIST` in proxy.ts or every custom-domain og:image 403s.
- Relative same-origin paths resolve against the fixed platform base, never the request Host header (Host-spoof SSRF oracle).
- Testing gotcha: API route tests that call the handler many times must `jest.mock("@/utils/rate-limit")` — in the jsdom env the pg pool can't initialize and the Postgres-backed limiter degrades cumulatively (early tests pass, later ones hit the 5s jest timeout), which looks like a logic bug but isn't.
