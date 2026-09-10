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
 * Module-level convenience constant for import-time use (module-scope
 * schema/constant builders). Request-time code that historically read the
 * env var per call should prefer getSiteUrl() so tests can stub the env.
 */
export const SITE_URL = getSiteUrl();

/** Module-level convenience constant: hostname of SITE_URL. */
export const SITE_HOST = getSiteHost();
