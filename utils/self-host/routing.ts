// Pure routing decisions for single-tenant self-host mode.
//
// No fs / next / env imports so proxy.ts (which builds the actual NextResponse)
// and the unit tests share the EXACT same rules. The proxy reads MM_SELF_HOST*
// from the environment and delegates each per-path decision to the helpers here.

// Pages that describe Milk Market the PLATFORM — the public marketplace, Nostr
// discovery shortcuts, the Pro/Herd billing surface, and the platform marketing,
// info, and legal/policy pages — are all hidden on a seller's own single-tenant
// instance. On self-host the only UI the owner should ever see is their own
// branded storefront, so all of these redirect back to the storefront home.
// (Self-host sellers publish their OWN terms/privacy/return policy via the
// storefront page builder; the platform's legal pages don't apply to them.)
const SELF_HOST_BLOCKED_PAGE_PREFIXES = [
  "/marketplace",
  "/pro",
  "/communities",
  "/about",
  "/faq",
  "/producer-guide",
  "/contact",
  "/terms",
  "/privacy",
];

// Returns true for any PAGE path that should redirect back to the storefront
// home instead of rendering.
export function isSelfHostBlockedPage(pathname: string): boolean {
  for (const prefix of SELF_HOST_BLOCKED_PAGE_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return true;
  }
  return (
    /^\/npub[a-z0-9]+$/i.test(pathname) || /^\/naddr[a-z0-9]+$/i.test(pathname)
  );
}

// The single seller-status read endpoint is the one /api/stripe/connect/* route
// that stays live on self-host: the storefront calls it to decide whether to
// show the card option (it is made self-host-aware to report the owner's own
// Stripe account). Everything else under connect is Connect onboarding /
// transfers / management, which has no meaning on a single-tenant instance.
export const SELF_HOST_CONNECT_ALLOW = "/api/stripe/connect/seller-status";

// Platform billing / Stripe Connect API routes that must be refused on a
// self-host instance. The owner already has lifetime access (nothing to buy)
// and card charges run through their OWN standard Stripe account (no Connect).
// The read-only /api/pro/status, /api/pro/export-store, and the seller-status
// gate above all stay live.
export function isSelfHostBlockedApi(pathname: string): boolean {
  if (!pathname.startsWith("/api/")) return false;

  if (pathname.startsWith("/api/stripe/connect/")) {
    return pathname !== SELF_HOST_CONNECT_ALLOW;
  }

  return (
    pathname.startsWith("/api/pro/create-lifetime") ||
    pathname.startsWith("/api/pro/create-subscription") ||
    pathname.startsWith("/api/pro/cancel") ||
    pathname.startsWith("/api/pro/manual-invoice") ||
    pathname.startsWith("/api/pro/confirm-invoice") ||
    pathname.startsWith("/api/pro/verify-invoice")
  );
}

// Whether to trust an inbound `x-mm-self-host` header. The proxy sets that
// header only on a real self-host deployment, but a client could spoof it on
// the hosted platform. Fail closed: honor it ONLY when THIS server process is
// itself running in self-host mode (`MM_SELF_HOST` env). Truthiness mirrors
// truthyEnv in config.ts. Kept here (pure, no imports) so _app.tsx — which is
// bundled for the client and must not import the server-only config module —
// can share the exact decision with the proxy and the tests.
export function selfHostHeaderTrusted(
  envValue: string | undefined,
  headerValue: string | null
): boolean {
  if (headerValue !== "1") return false;
  const v = (envValue ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// Build the internal stall path for a public path on the self-host instance.
// "/" → "/stall/<slug>"; "/cart" → "/stall/<slug>/cart". Pure string join; the
// proxy appends the query string and performs the rewrite.
export function selfHostStallRewritePath(
  pathname: string,
  slug: string
): string {
  const prefix = `/stall/${slug}`;
  if (pathname === "/" || pathname === "") return prefix;
  return `${prefix}${pathname}`;
}
