/**
 * Canonical platform origin ("site URL") for the marketplace.
 *
 * Single source of truth for the platform's own origin and hostname.
 * Everything that builds a platform URL (canonical tags, JSON-LD, sitemaps,
 * email links, agent discovery docs) or matches the platform hostname
 * (proxy host routing) must import from here instead of hardcoding the
 * domain, so a base-domain change is a one-env-var cutover
 * (NEXT_PUBLIC_BASE_URL) plus this fallback.
 *
 * Keep this module dependency-free: it is imported by proxy.ts, client
 * components, API routes, and tests alike.
 *
 * Intentionally NOT sourced from here (domain-bound identities/config that
 * change only at cutover, not per-environment): *@self-sown.com email
 * mailboxes (SendGrid-verified), the GitHub repo URL, social handles, the
 * platform NIP-05 identifier, and static files under public/.
 */

const FALLBACK_SITE_URL = "https://self-sown.com";

/**
 * The platform origin, e.g. "https://self-sown.com".
 * Returns NEXT_PUBLIC_BASE_URL verbatim when set (same semantics as the
 * `process.env.NEXT_PUBLIC_BASE_URL || FALLBACK` expressions
 * this module replaces); falls back to the production domain when unset or
 * empty. Callers must not assume the value is normalized.
 */
export function getSiteUrl(): string {
  return process.env.NEXT_PUBLIC_BASE_URL || FALLBACK_SITE_URL;
}

/**
 * The platform hostname, e.g. "self-sown.com". Derived from getSiteUrl();
 * tolerates values with or without a protocol and never throws.
 */
export function getSiteHost(): string {
  const url = getSiteUrl();
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname;
  } catch {
    return new URL(FALLBACK_SITE_URL).hostname;
  }
}

/**
 * Absolute https origin for an inbound Host header value (port-stripped,
 * lowercased), falling back to the platform origin for localhost/loopback or
 * a missing header. Used by agent-discovery surfaces (RFC 9728 metadata,
 * WWW-Authenticate challenges) that must name the origin the client is
 * actually talking to — on a seller custom domain that is the seller's host,
 * not SITE_URL.
 */
export function originFromHostHeader(
  hostHeader: string | string[] | undefined
): string {
  const raw = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  const host = (raw || "").toLowerCase().trim();
  // Validate as an authority before reflecting it into metadata documents and
  // WWW-Authenticate quoted strings: hostname/IPv4 with an optional port —
  // anything else (quotes, spaces, CRLF, userinfo) falls back to the
  // platform origin.
  if (!/^[a-z0-9.-]+(:\d+)?$/.test(host)) return getSiteUrl();
  if (host.startsWith("localhost") || host.startsWith("127.")) {
    // Loopback (self-host dev): reflect the actual origin — http, port kept
    // (80 is http's default) — so RFC 9728 §3.3 matching works for local
    // agents instead of pointing them at the platform origin.
    return `http://${host.replace(/:80$/, "")}`;
  }
  // The default HTTPS port is not part of the origin; any OTHER port is
  // (RFC 6454) and must be preserved — RFC 9728 §3.3 clients discard
  // metadata whose resource identifier doesn't match the origin they called.
  return `https://${host.replace(/:443$/, "")}`;
}

/**
 * Module-level convenience constant for import-time use (module-scope
 * schema/constant builders). Request-time code that historically read the
 * env var per call should prefer getSiteUrl() so tests can stub the env.
 */
export const SITE_URL = getSiteUrl();

/** Module-level convenience constant: hostname of SITE_URL. */
export const SITE_HOST = getSiteHost();

/**
 * The retired base domain ("milk.market"), still owned and pointing at this
 * deployment. Page traffic on it 301s to SITE_HOST (preserving path + query,
 * so previously-sent email deep links with long click TTLs keep working);
 * /api/ and /.well-known/ traffic is exempt (webhook senders treat 3xx as
 * delivery failure; verification/discovery files must stay reachable) and is
 * served as platform traffic via PLATFORM_HOST_SUFFIXES. Time-boxed: retire
 * the redirect (again) once legacy traffic fades.
 */
export const LEGACY_SITE_HOST = "milk.market";
