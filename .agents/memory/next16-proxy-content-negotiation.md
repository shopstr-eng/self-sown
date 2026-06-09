---
name: Next 16 proxy.ts + content negotiation
description: Next.js 16 uses proxy.ts (not middleware.ts), and NextResponse.rewrite drops the destination query string — forward data via request headers instead.
---

# Next.js 16 edge interception: proxy.ts, not middleware.ts

Next.js 16 renamed the edge interception file from `middleware.ts` to `proxy.ts`
(exported `proxy()` function). Having BOTH files present is a hard build error:
"Both middleware file and proxy file detected". This repo already ships a
`proxy.ts` (custom-domain storefront routing) — extend that, never add a
`middleware.ts`.

**How to apply:** any edge-layer logic (redirects, rewrites, header injection,
content negotiation) goes inside the existing `proxy()` body. Order matters:
place new rewrite blocks after the www→apex redirect and gate them with
`!isCustomDomain(hostname)` so seller custom domains keep their own routing.

# NextResponse.rewrite overrides the destination query string

When you `NextResponse.rewrite(new URL("/api/foo?path=...&format=...", req.url))`,
Next replaces the destination's query string with the ORIGINAL request's query.
So search params you add to the rewrite URL silently do NOT reach the API route —
the handler sees only the original request's query and falls back to defaults
(symptom: every variant returns the same default representation).

**Why:** this cost a long debug — proxy debug header proved it computed the right
format, but the API route always returned the default because the format query
param never arrived.

**How to apply:** forward data to the rewrite target via REQUEST HEADERS, which
are reliably propagated:
`NextResponse.rewrite(url, { request: { headers: newHeaders } })`, then read
those headers in the API route (keep a query-param fallback for direct calls).

# Accept-header content negotiation must honor mixed Accept

Agent SDKs often send `text/markdown, text/html;q=0.9` or
`application/json, text/html`. If you only honor markdown/json when `text/html`
is ABSENT, those agents wrongly get HTML. Browsers and social/SEO bots
(Googlebot, facebookexternalhit, Twitterbot…) never request `text/markdown` or
`application/json` explicitly, so treat those two as high-signal and select them
even when `text/html` is also present. Keep `text/plain` gated behind no-HTML
(lower signal). Also short-circuit known SEO/social-preview UAs to HTML first so
link unfurls and crawlers always see real HTML + OG tags.

# Per-stall (custom-domain) GEO content negotiation

Extending content negotiation to seller storefronts (custom domains + platform
`/stall/<slug>`) requires the stall's slug, which only comes from the async
`lookupByHost` network call. Two ordering rules that bite:

- Dynamic GEO files (`/llms.txt`, `/robots.txt`, `/rss.xml`, `/feed.xml`) on a
  custom domain must be EXCLUDED from the static-asset passthrough (which runs
  BEFORE slug resolution) or they serve the platform's static /public copies
  untailored. Gate the passthrough with a `pathname in STALL_GEO_DYNAMIC_FORMAT`
  check, then handle them after slug resolution.
- When the slug doesn't resolve (unconfigured/unverified domain), fall through to
  `NextResponse.next()` so the platform static file still serves — never 404.
  **Why:** custom domains hit the proxy's static-ext passthrough first; without the
  exclusion the tailored handler is never reached.
  **How to apply:** one shared backing route `/api/stall-agent-view` takes
  `slug`+`format` (md/json/txt/llms/robots/rss) via request headers (query
  fallback); reuse `resolveStallBranding` so seller branding is never clobbered.
  Malformed `%`-encoding in `/stall/<slug>` must be caught around
  `decodeURIComponent` (the downstream Next dynamic-route 500 on bad encoding is
  framework-level and pre-existing, not ours).
