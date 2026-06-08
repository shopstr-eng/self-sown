import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { nip19 } from "nostr-tools";
import { lookupByHost } from "@/utils/storefront/host-cache";

// Routes that should NOT be rewritten under /stall/<slug>/ on a custom
// domain — they live at the root of the seller's site (or fall through to
// shared platform infrastructure that just happens to serve the same code).
const CUSTOM_DOMAIN_PASSTHROUGH_PREFIXES = [
  "/_next/",
  "/static/",
  "/images/",
  "/favicon",
  "/robots.txt",
  "/sitemap.xml",
  "/manifest",
  "/sw.js",
  "/service-worker.js",
];

// Any path ending in a known static-asset extension is served as-is from
// /public on the custom domain. Without this, root-level files like
// `/instagram-icon.png`, `/milk-market.png`, `/workbox-*.js`,
// `/currencySelection.json`, uploaded fonts, etc. get rewritten to
// `/stall/<slug>/<file>` and return the storefront HTML instead of the
// real asset.
const STATIC_ASSET_EXT_RE =
  /\.(?:png|jpe?g|gif|svg|ico|webp|avif|bmp|tiff?|css|js|mjs|map|json|txt|xml|webmanifest|woff2?|ttf|otf|eot|mp3|mp4|webm|ogg|wav|pdf)$/i;

// Shared platform routes that render their own standalone pages on a
// custom domain (rather than being absorbed under /stall/<slug>/). The
// listing page already wraps itself in StorefrontThemeWrapper so it
// inherits the seller's theme. Cart, checkout, auth, onboarding and
// account settings render with their own chrome.
const CUSTOM_DOMAIN_PLATFORM_PASSTHROUGH = [
  "/listing/",
  "/listing",
  "/cart",
  "/order-summary/",
  "/order-summary",
  "/auth/",
  "/auth",
  "/onboarding",
  "/settings/",
  "/settings",
];

const CUSTOM_DOMAIN_API_ALLOWLIST = [
  "/api/storefront/",
  "/api/db/fetch-products",
  "/api/db/fetch-profiles",
  "/api/db/fetch-reviews",
  "/api/db/fetch-communities",
  // Discount code validation + usage tracking. The buyer cart on a custom
  // domain calls these to apply a copy/pasted welcome (or seller-issued)
  // code at checkout. Without them gated in, the proxy returns 403 and the
  // cart surfaces a generic "Failed to validate discount code" error even
  // though the code itself is valid.
  "/api/db/discount-codes",
  "/api/db/discount-code-used",
  // Affiliate validate / click tracking / referral recording. The buyer
  // checkout on a custom domain calls /api/affiliates/validate to apply a
  // code, /api/affiliates/record-click on landing, and
  // /api/affiliates/record-referral after a successful payment. Without
  // these gated in, the proxy returns 403 and affiliate codes silently
  // fail to validate on custom stalls/domains.
  "/api/affiliates/",
  "/api/nostr/",
  "/api/lightning/",
  "/api/cashu/",
  "/api/stripe/",
  "/api/email/",
  // Public, read-only Pro entitlement check. The storefront render layer
  // (StorefrontLayout / StorefrontThemeWrapper) calls this to decide whether to
  // serve the seller's premium design (custom colors/fonts/sections). It fails
  // closed, so without this gated in the proxy returns 403, the render layer
  // reads that as "not Pro", and EVERY custom-domain stall reverts to the
  // default Milk Market look even when the seller is fully entitled.
  "/api/pro/status",
  "/api/og-preview",
  "/api/sitemap.xml",
  "/api/auth/",
  "/api/signup",
  "/api/validate-password",
  "/api/validate-password-auth",
  "/api/get-encryption-nsec",
  "/api/health",
];

// Canonical platform hosts that should NEVER be treated as a seller's
// custom domain. Uses exact host (and explicit subdomain) matches rather
// than substring tests so legitimate seller domains that happen to contain
// "replit" or "milk.market" as a substring (e.g. `myreplitfarm.com`) are
// still routed correctly.
const PLATFORM_HOST_SUFFIXES = [
  "milk.market", // milk.market + *.milk.market
  "replit.app", // *.replit.app
  "replit.dev", // *.replit.dev (preview)
  "repl.co",
];

const PLATFORM_HOST_EXACT = new Set(["localhost", "127.0.0.1", "0.0.0.0"]);

// --- Content negotiation for LLMs / AI agents --------------------------------
// On the main platform host, the content pages below can be served as
// markdown/JSON/plain-text (via /api/agent-view) when the client asks for a
// non-HTML representation by Accept header or identifies as a known LLM
// crawler. Browsers and SEO/social unfurlers keep getting HTML so OpenGraph
// and SSR behaviour is preserved.
const AGENT_VIEW_PATHS = new Set([
  "/",
  "/about",
  "/faq",
  "/contact",
  "/producer-guide",
  "/terms",
  "/privacy",
]);

// Per-stall GEO/agent files served dynamically (tailored to the seller) on a
// custom domain instead of falling through to the platform's static /public
// copies. Maps the request path to the stall-agent-view `format` it produces.
const STALL_GEO_DYNAMIC_FORMAT: Record<string, string> = {
  "/llms.txt": "llms",
  "/robots.txt": "robots",
  "/rss.xml": "rss",
  "/feed.xml": "rss",
};

const LLM_AGENT_UA =
  /(GPTBot|ChatGPT-User|OAI-SearchBot|ClaudeBot|Claude-Web|anthropic-ai|PerplexityBot|Perplexity|Google-Extended|Applebot-Extended|CCBot|cohere-ai|Bytespider|Amazonbot|Diffbot|YouBot|Meta-ExternalAgent)/i;

const HTML_ONLY_UA =
  /(Googlebot|bingbot|DuckDuckBot|Slurp|Baiduspider|YandexBot|facebookexternalhit|Facebot|Twitterbot|LinkedInBot|Slackbot|Discordbot|TelegramBot|WhatsApp|Pinterest|redditbot|Embedly|SkypeUriPreview)/i;

function negotiateAgentFormat(
  accept: string,
  userAgent: string
): "md" | "json" | "txt" | null {
  if (HTML_ONLY_UA.test(userAgent)) return null;

  const a = accept.toLowerCase();

  // High-signal explicit machine formats win even when text/html is also
  // present (e.g. "text/markdown, text/html;q=0.9" from agent SDKs). Browsers
  // and social/SEO bots never request markdown or json explicitly, so this is
  // safe for normal navigation and link unfurling.
  if (a.includes("application/json")) return "json";
  if (a.includes("text/markdown") || a.includes("text/x-markdown")) return "md";

  // text/plain is lower-signal, so only honor it when html isn't requested.
  if (!a.includes("text/html") && a.includes("text/plain")) return "txt";

  if (LLM_AGENT_UA.test(userAgent)) return "md";

  return null;
}

function hostStripPort(host: string): string {
  return host.split(":")[0]?.toLowerCase() ?? "";
}

function isCustomDomain(rawHost: string): boolean {
  const host = hostStripPort(rawHost);
  if (!host) return false;
  if (PLATFORM_HOST_EXACT.has(host)) return false;
  for (const suffix of PLATFORM_HOST_SUFFIXES) {
    if (host === suffix || host.endsWith("." + suffix)) return false;
  }
  return true;
}

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const hostname = (request.headers.get("host") || "").toLowerCase();

  if (pathname === "/.well-known/agent.json") {
    return NextResponse.rewrite(
      new URL("/api/.well-known/agent.json", request.url)
    );
  }

  if (hostname === "www.milk.market") {
    const url = new URL(request.url);
    url.hostname = "milk.market";
    return NextResponse.redirect(url, 301);
  }

  // Content negotiation for LLMs/agents on the main platform host only. Custom
  // domains fall through to their own storefront routing below.
  if (!isCustomDomain(hostname) && AGENT_VIEW_PATHS.has(pathname)) {
    const format = negotiateAgentFormat(
      request.headers.get("accept") || "",
      request.headers.get("user-agent") || ""
    );
    if (format) {
      const url = new URL("/api/agent-view", request.url);
      url.searchParams.set("path", pathname);
      url.searchParams.set("format", format);
      // Forward path/format via request headers too: NextResponse.rewrite can
      // override the destination query string with the original request's, so
      // headers are the reliable channel for the API route to read.
      const requestHeaders = new Headers(request.headers);
      requestHeaders.set("x-agent-view-path", pathname);
      requestHeaders.set("x-agent-view-format", format);
      const res = NextResponse.rewrite(url, {
        request: { headers: requestHeaders },
      });
      res.headers.set("Vary", "Accept, User-Agent");
      return res;
    }
  }

  // Per-stall content negotiation on the platform host: /stall/<slug> can be
  // served as tailored markdown/JSON/plain-text for agents. Custom domains are
  // handled separately inside their own block below.
  if (!isCustomDomain(hostname)) {
    const stallMatch = pathname.match(/^\/stall\/([^/]+)\/?$/);
    if (stallMatch && stallMatch[1]) {
      let stallSlug = "";
      try {
        stallSlug = decodeURIComponent(stallMatch[1]);
      } catch {
        // Malformed percent-encoding — leave blank so we skip negotiation and
        // let the normal route handle (and 404) it instead of throwing.
        stallSlug = "";
      }
      if (stallSlug && stallSlug !== "_custom-domain") {
        const format = negotiateAgentFormat(
          request.headers.get("accept") || "",
          request.headers.get("user-agent") || ""
        );
        if (format) {
          const url = new URL("/api/stall-agent-view", request.url);
          url.searchParams.set("slug", stallSlug);
          url.searchParams.set("format", format);
          const requestHeaders = new Headers(request.headers);
          requestHeaders.set("x-stall-slug", stallSlug);
          requestHeaders.set("x-stall-format", format);
          const res = NextResponse.rewrite(url, {
            request: { headers: requestHeaders },
          });
          res.headers.set("Vary", "Accept, User-Agent");
          return res;
        }
      }
    }
  }

  if (isCustomDomain(hostname)) {
    // GEO/agent files (llms.txt, robots.txt, rss.xml, feed.xml) are served
    // dynamically + tailored to the seller below, so they must NOT be caught by
    // the static-asset passthrough. Everything else static still passes through.
    const isStallGeoDynamic = pathname in STALL_GEO_DYNAMIC_FORMAT;
    if (
      !isStallGeoDynamic &&
      (CUSTOM_DOMAIN_PASSTHROUGH_PREFIXES.some((p) => pathname.startsWith(p)) ||
        STATIC_ASSET_EXT_RE.test(pathname))
    ) {
      return NextResponse.next();
    }

    // Look up the shop slug for this custom domain up-front so we can flag
    // every render with `x-mm-custom-domain` + `x-mm-shop-slug`. _app.tsx
    // reads these in getInitialProps to suppress the platform TopNav and
    // wrap the page in the storefront chrome on the very first SSR pass
    // (no client-side flash).
    const origin = request.nextUrl.origin;
    const resolution =
      pathname.startsWith("/api/") || pathname === "/.well-known/agent.json"
        ? { slug: null as string | null, pubkey: null as string | null }
        : await lookupByHost(origin, hostname);
    const slug = resolution.slug;
    const pubkey = resolution.pubkey;

    const buildHeaders = () => {
      const h = new Headers(request.headers);
      h.set("x-mm-custom-domain", "1");
      h.set("x-mm-custom-domain-host", hostname);
      if (slug) h.set("x-mm-shop-slug", slug);
      // Seed SSR with the seller pubkey so _app.tsx can mount the storefront
      // wrapper on first render. Without this, the page renders once bare,
      // fetches the slug client-side, then remounts inside the wrapper —
      // visible as a flash or, in Safari with stale SW caches, a blank screen.
      if (pubkey) h.set("x-mm-shop-pubkey", pubkey);
      return h;
    };

    const rewriteToStallAgentView = (format: string) => {
      const url = new URL("/api/stall-agent-view", request.url);
      url.searchParams.set("slug", slug as string);
      url.searchParams.set("format", format);
      const h = buildHeaders();
      h.set("x-stall-slug", slug as string);
      h.set("x-stall-format", format);
      const res = NextResponse.rewrite(url, { request: { headers: h } });
      res.headers.set("Vary", "Accept, User-Agent");
      return res;
    };

    // Per-stall GEO/agent files (llms.txt, robots.txt, rss.xml, feed.xml),
    // tailored to this seller. If the domain has no resolved slug, fall through
    // to the platform's static /public copies.
    const geoFormat = STALL_GEO_DYNAMIC_FORMAT[pathname];
    if (geoFormat) {
      if (!slug) return NextResponse.next();
      return rewriteToStallAgentView(geoFormat);
    }

    // Content negotiation for the stall homepage: when an LLM/agent asks for a
    // non-HTML representation, serve tailored markdown/JSON/plain-text. Browsers
    // and SEO/social bots keep getting the HTML storefront.
    if (slug && (pathname === "/" || pathname === "")) {
      const format = negotiateAgentFormat(
        request.headers.get("accept") || "",
        request.headers.get("user-agent") || ""
      );
      if (format) return rewriteToStallAgentView(format);
    }

    // Shared platform routes (listing, cart, checkout, auth, etc.) render
    // their own standalone pages instead of being rewritten under /stall/<slug>/.
    if (
      CUSTOM_DOMAIN_PLATFORM_PASSTHROUGH.some(
        (p) =>
          pathname === p ||
          pathname === p.replace(/\/$/, "") ||
          pathname.startsWith(p.endsWith("/") ? p : p + "/")
      )
    ) {
      return NextResponse.next({ request: { headers: buildHeaders() } });
    }

    // API routes: gate to the allow-list. Storefront browsing + checkout +
    // account flows on the custom domain still call back into milk.market's
    // shared APIs (Stripe, Lightning, email, etc.) so they need to pass.
    if (pathname.startsWith("/api/")) {
      const allowed = CUSTOM_DOMAIN_API_ALLOWLIST.some((p) =>
        pathname.startsWith(p)
      );
      if (!allowed) {
        return NextResponse.json(
          { error: "Not available on this domain" },
          { status: 403 }
        );
      }
      return NextResponse.next({ request: { headers: buildHeaders() } });
    }

    if (!slug) {
      // Fallback: render the legacy custom-domain placeholder which does a
      // client-side lookup and surfaces a "domain not configured" message.
      return NextResponse.rewrite(
        new URL(
          `/stall/_custom-domain?domain=${encodeURIComponent(
            hostname
          )}&path=${encodeURIComponent(pathname)}`,
          request.url
        ),
        { request: { headers: buildHeaders() } }
      );
    }

    const stallPrefix = `/stall/${slug}`;
    // Idempotent: if the path is already under /stall/<slug>, do nothing.
    if (pathname === stallPrefix || pathname.startsWith(`${stallPrefix}/`)) {
      return NextResponse.next({ request: { headers: buildHeaders() } });
    }

    // Root → stall homepage.
    if (pathname === "/" || pathname === "") {
      return NextResponse.rewrite(
        new URL(`${stallPrefix}${search}`, request.url),
        { request: { headers: buildHeaders() } }
      );
    }

    // Everything else: prefix with /stall/<slug> so the existing dynamic
    // routes ([...stallPath].tsx, /listing/[slug], /cart, /orders) handle SSR.
    return NextResponse.rewrite(
      new URL(`${stallPrefix}${pathname}${search}`, request.url),
      { request: { headers: buildHeaders() } }
    );
  }

  if (
    pathname.match(/^\/npub[a-zA-Z0-9]+$/) &&
    !pathname.startsWith("/marketplace/")
  ) {
    const url = new URL(`/marketplace${pathname}`, request.url);
    return NextResponse.redirect(url);
  }

  if (
    pathname.match(/^\/naddr[a-zA-Z0-9]+$/) &&
    !pathname.startsWith("/listing/")
  ) {
    const url = new URL(`/listing${pathname}`, request.url);
    return NextResponse.redirect(url);
  }

  if (pathname.startsWith("/naddr") && !pathname.startsWith("/communities/")) {
    try {
      const decoded = nip19.decode(pathname.substring(1));
      if (decoded.type === "naddr" && decoded.data.kind === 34550) {
        return NextResponse.redirect(
          new URL(`/communities${pathname}`, request.url)
        );
      }
    } catch {
      /* ignore */
    }
  }

  return NextResponse.next();
}
