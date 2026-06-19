import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { nip19 } from "nostr-tools";
import { lookupByHost } from "@/utils/storefront/host-cache";
import {
  isSelfHostBlockedPage,
  isSelfHostBlockedApi,
  selfHostStallRewritePath,
} from "@/utils/self-host/routing";

// Routes that should NOT be rewritten under /stall/<slug>/ on a custom
// domain — they live at the root of the seller's site (or fall through to
// shared platform infrastructure that just happens to serve the same code).
const CUSTOM_DOMAIN_PASSTHROUGH_PREFIXES = [
  "/_next/",
  "/static/",
  "/images/",
  "/favicon",
  "/robots.txt",
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
  // Buyer orders dashboard — reachable on a seller's custom domain so
  // {{review_link}} deep-links from flow emails open the review modal there.
  "/orders/",
  "/orders",
  "/settings/",
  "/settings",
];

const CUSTOM_DOMAIN_API_ALLOWLIST = [
  "/api/storefront/",
  // UCP (Universal Commerce Protocol) public catalog endpoints. On a seller's
  // custom domain these are host-scoped to that seller (resolved + membership-
  // gated server-side from the verified domain), so they must pass the gate.
  // Checkout-session writes live under the same prefix and enforce their own
  // read_write API-key auth inside the handler.
  "/api/ucp/",
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
  "/sitemap.xml": "sitemap",
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

// Endpoints that set their OWN accurate, per-request RateLimit headers (via
// applyRateLimit) carry this marker so the advisory wrapper below doesn't add a
// second, duplicate set. The marker is stripped before the response is returned.
const RL_SKIP_HEADER = "x-mm-rl-skip";

// Advisory RateLimit headers for agents/scanners. Real per-IP enforcement lives
// in the API handlers (utils/rate-limit.ts); these inform automated clients of
// the documented budget on EVERY navigation/storefront response (both the
// platform host and seller custom domains) so the limit is observable up front.
function withAdvisoryRateLimitHeaders(res: NextResponse): NextResponse {
  if (res.headers.get(RL_SKIP_HEADER)) {
    res.headers.delete(RL_SKIP_HEADER);
    return res;
  }
  if (!res.headers.has("RateLimit-Limit")) {
    res.headers.set("RateLimit-Limit", "600");
    res.headers.set("RateLimit-Remaining", "600");
    res.headers.set("RateLimit-Reset", "60");
    res.headers.set("RateLimit-Policy", '"agent";q=600;w=60');
    res.headers.set("X-RateLimit-Limit", "600");
    res.headers.set("X-RateLimit-Remaining", "600");
    res.headers.set("X-RateLimit-Reset", "60");
  }
  return res;
}

export async function proxy(request: NextRequest) {
  return withAdvisoryRateLimitHeaders(await routeRequest(request));
}

async function routeRequest(request: NextRequest) {
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

  // Web Bot Auth signature directory. Handled here (after the www->apex redirect
  // so it canonicalizes, but before any host-specific routing) so the same
  // canonical key directory is served on the platform host AND on every seller
  // custom domain.
  if (pathname === "/.well-known/http-message-signatures-directory") {
    const res = NextResponse.rewrite(
      new URL("/api/.well-known/http-message-signatures-directory", request.url)
    );
    res.headers.set(RL_SKIP_HEADER, "1");
    return res;
  }

  // Single-tenant self-host mode. When MM_SELF_HOST is on, this whole instance
  // serves exactly one seller's storefront regardless of host: the marketplace,
  // Nostr discovery, and platform Pro-billing surfaces are hidden, and every
  // other path is served under the owner's /stall/<slug>. We take this branch
  // before any host-based routing so it applies on localhost, *.replit.app, and
  // the seller's own domain alike. The slug/pubkey come from the environment —
  // no per-host DB lookup. If self-host is enabled but the slug is missing we
  // FAIL CLOSED with a clear misconfiguration error rather than falling back to
  // the full multi-tenant platform (which would expose the marketplace,
  // discovery, and every other seller on what is meant to be a private,
  // single-tenant instance).
  const selfHostEnabled = /^(1|true|yes|on)$/i.test(
    (process.env.MM_SELF_HOST || "").trim()
  );
  const selfHostSlug = (process.env.MM_SELF_HOST_SLUG || "").trim();
  if (selfHostEnabled) {
    if (!selfHostSlug) {
      return new NextResponse(
        "Self-host mode is enabled (MM_SELF_HOST) but MM_SELF_HOST_SLUG is " +
          "not set. Configure your storefront slug to start serving your store.",
        {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }
      );
    }
    return routeSelfHost(request, selfHostSlug);
  }

  // UCP discovery profile. On the platform host this is the aggregate
  // marketplace profile; custom domains serve their own seller-scoped profile
  // inside the custom-domain block below (so the guard here is platform-only).
  // Unlike /.well-known/agent.json (identical on every host) the UCP profile is
  // host-scoped, so it is NOT short-circuited at the top of the router.
  if (!isCustomDomain(hostname) && pathname === "/.well-known/ucp") {
    return NextResponse.rewrite(new URL("/api/.well-known/ucp", request.url));
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
      res.headers.set(RL_SKIP_HEADER, "1");
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
          res.headers.set(RL_SKIP_HEADER, "1");
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
    // NIP-05: served dynamically per-seller below, so it must NOT be swallowed by
    // the static-asset passthrough (".json" matches STATIC_ASSET_EXT_RE).
    const isCustomDomainNostrJson = pathname === "/.well-known/nostr.json";
    if (
      !isStallGeoDynamic &&
      !isCustomDomainNostrJson &&
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
      // Pass the original public pathname so SSR can emit correct canonical
      // and og:url for this custom domain (the internal Next.js rewrite turns
      // "/" into "/stall/<slug>", but the canonical must stay at the seller
      // domain's public path, e.g. "https://farmer.com/" not
      // "https://milk.market/stall/farmname").
      h.set("x-mm-original-path", pathname || "/");
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
      res.headers.set(RL_SKIP_HEADER, "1");
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

    // NIP-05: serve a per-seller /.well-known/nostr.json so this custom domain
    // advertises a `<username>@<domain>` Nostr address resolving to the seller's
    // own pubkey. The seller pubkey is already resolved (and membership-gated)
    // above, so pass it through via header. If the domain has no resolved seller
    // (unconfigured/hidden), fall through to the platform's static /public copy.
    if (isCustomDomainNostrJson) {
      if (!pubkey) return NextResponse.next();
      const url = new URL("/api/storefront/nostr-json", request.url);
      const res = NextResponse.rewrite(url, {
        request: { headers: buildHeaders() },
      });
      res.headers.set(RL_SKIP_HEADER, "1");
      return res;
    }

    // UCP discovery profile, scoped to this seller. Served even when no slug
    // resolved: the endpoint resolves + membership-gates the seller from the
    // verified domain (forwarded via x-mm-custom-domain-host) and 404s if none.
    if (pathname === "/.well-known/ucp") {
      const res = NextResponse.rewrite(
        new URL("/api/.well-known/ucp", request.url),
        { request: { headers: buildHeaders() } }
      );
      res.headers.set(RL_SKIP_HEADER, "1");
      return res;
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
    return NextResponse.redirect(url, 308);
  }

  if (
    pathname.match(/^\/naddr[a-zA-Z0-9]+$/) &&
    !pathname.startsWith("/listing/")
  ) {
    const url = new URL(`/listing${pathname}`, request.url);
    return NextResponse.redirect(url, 308);
  }

  if (pathname.startsWith("/naddr") && !pathname.startsWith("/communities/")) {
    try {
      const decoded = nip19.decode(pathname.substring(1));
      if (decoded.type === "naddr" && decoded.data.kind === 34550) {
        return NextResponse.redirect(
          new URL(`/communities${pathname}`, request.url),
          308
        );
      }
    } catch {
      /* ignore */
    }
  }

  return NextResponse.next();
}

// Resolve the configured self-host owner pubkey to lowercase hex. Accepts an
// npub or 64-char hex; returns null for anything else (the header is simply
// omitted, so a malformed value can never seed SSR with a bogus pubkey).
function selfHostPubkeyHex(): string | null {
  const raw = (process.env.MM_SELF_HOST_PUBKEY || "").trim();
  if (!raw) return null;
  if (raw.startsWith("npub1")) {
    try {
      const decoded = nip19.decode(raw);
      if (decoded.type === "npub" && typeof decoded.data === "string") {
        return decoded.data.toLowerCase();
      }
    } catch {
      return null;
    }
    return null;
  }
  if (/^[0-9a-f]{64}$/i.test(raw)) return raw.toLowerCase();
  return null;
}

// Route a request on a single-tenant self-host instance. Mirrors the custom-
// domain block above (static passthrough, GEO/agent files, platform pages,
// stall rewrite) but sources the slug/pubkey from the environment and adds the
// self-host hiding rules (marketplace/discovery/Pro-billing pages → home;
// billing/Connect APIs → 404).
function routeSelfHost(request: NextRequest, slug: string) {
  const { pathname, search } = request.nextUrl;
  const hostname = (request.headers.get("host") || "").toLowerCase();
  const pubkey = selfHostPubkeyHex();

  const buildHeaders = () => {
    const h = new Headers(request.headers);
    // Reuse the custom-domain SSR signals so _app.tsx wraps every page in the
    // storefront chrome and suppresses the platform TopNav on the first render.
    h.set("x-mm-custom-domain", "1");
    h.set("x-mm-self-host", "1");
    h.set("x-mm-custom-domain-host", hostname);
    h.set("x-mm-original-path", pathname || "/");
    h.set("x-mm-shop-slug", slug);
    if (pubkey) h.set("x-mm-shop-pubkey", pubkey);
    return h;
  };

  // GEO/agent files are served dynamically + tailored below, so they must NOT
  // be caught by the static-asset passthrough. Everything else static passes.
  const isStallGeoDynamic = pathname in STALL_GEO_DYNAMIC_FORMAT;
  if (
    !isStallGeoDynamic &&
    (CUSTOM_DOMAIN_PASSTHROUGH_PREFIXES.some((p) => pathname.startsWith(p)) ||
      STATIC_ASSET_EXT_RE.test(pathname))
  ) {
    return NextResponse.next();
  }

  // UCP discovery profile for this single-tenant instance (the endpoint scopes
  // it to the configured owner via server env, not a header).
  if (pathname === "/.well-known/ucp") {
    const res = NextResponse.rewrite(
      new URL("/api/.well-known/ucp", request.url),
      { request: { headers: buildHeaders() } }
    );
    res.headers.set(RL_SKIP_HEADER, "1");
    return res;
  }

  // Hidden surfaces (marketplace, Nostr discovery, Pro-billing pages) redirect
  // back to the storefront home, which then renders the owner's stall.
  if (isSelfHostBlockedPage(pathname)) {
    return NextResponse.redirect(new URL("/", request.url), 307);
  }

  // API routing: refuse the platform billing + Stripe Connect endpoints that
  // have no meaning on a single-tenant instance; pass everything else through
  // (storefront, payments, MCP, email, etc.) with the self-host headers.
  if (pathname.startsWith("/api/")) {
    if (isSelfHostBlockedApi(pathname)) {
      return NextResponse.json(
        { error: "Not available on this instance" },
        { status: 404 }
      );
    }
    return NextResponse.next({ request: { headers: buildHeaders() } });
  }

  const rewriteToStallAgentView = (format: string) => {
    const url = new URL("/api/stall-agent-view", request.url);
    url.searchParams.set("slug", slug);
    url.searchParams.set("format", format);
    const h = buildHeaders();
    h.set("x-stall-slug", slug);
    h.set("x-stall-format", format);
    const res = NextResponse.rewrite(url, { request: { headers: h } });
    res.headers.set("Vary", "Accept, User-Agent");
    res.headers.set(RL_SKIP_HEADER, "1");
    return res;
  };

  // Per-stall GEO/agent files (llms.txt, robots.txt, rss.xml, feed.xml).
  const geoFormat = STALL_GEO_DYNAMIC_FORMAT[pathname];
  if (geoFormat) {
    return rewriteToStallAgentView(geoFormat);
  }

  // Content negotiation for the stall homepage: agents asking for a non-HTML
  // representation get tailored markdown/JSON/plain-text; browsers + social
  // bots keep getting the HTML storefront.
  if (pathname === "/" || pathname === "") {
    const format = negotiateAgentFormat(
      request.headers.get("accept") || "",
      request.headers.get("user-agent") || ""
    );
    if (format) return rewriteToStallAgentView(format);
  }

  // Shared platform pages (listing, cart, checkout, auth, orders, settings)
  // render their own standalone chrome rather than being nested in the stall.
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

  // Idempotent: already under /stall/<slug>.
  const stallPrefix = `/stall/${slug}`;
  if (pathname === stallPrefix || pathname.startsWith(`${stallPrefix}/`)) {
    return NextResponse.next({ request: { headers: buildHeaders() } });
  }

  // Root → stall homepage; everything else nested under the stall so the
  // existing dynamic routes handle SSR.
  const rewritePath = selfHostStallRewritePath(pathname, slug);
  return NextResponse.rewrite(new URL(`${rewritePath}${search}`, request.url), {
    request: { headers: buildHeaders() },
  });
}
