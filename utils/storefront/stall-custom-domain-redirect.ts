/**
 * Platform-host → custom-domain permanent redirect for seller storefronts.
 *
 * Standing rule (utils/db/custom-domains.ts resolveSellerStorefrontUrl): a
 * VERIFIED custom domain is the seller's canonical storefront URL on every
 * link surface we generate (share links, affiliate links, emails, MCP tools).
 * But crawlers still DISCOVER the platform /stall/<slug> URL from old shares,
 * relays, and external links — and serving identical content there with a
 * platform canonical splits search ranking and identity across two hosts.
 * So on the platform host the stall pages 301/308 /stall/<slug> (and every
 * subpage) to the custom domain, consolidating ranking on ONE host.
 *
 * The redirect gate is deliberately STRICTER than the share-link rule: the
 * domain must be verified AND its TLS certificate live (tls_status "active"
 * via resolveLiveSellerCustomDomainUrl) AND the seller not hidden. DNS
 * verification runs up to ~24h before certificate provisioning finishes (and
 * provisioning can fail), so a verified-only redirect would bounce visitors
 * and crawlers off the working platform page onto a TLS error. Hidden
 * (lapsed-past-read-only) sellers' domains stop resolving entirely, so
 * redirecting them would strand visitors on the "domain not configured"
 * placeholder. A lookup failure must degrade to NO redirect — keep serving
 * the platform page; never break the stall because the redirect check
 * itself failed.
 *
 * Product LISTING pages (pages/listing/[[...productId]].tsx) reuse this same
 * redirect policy one level down: /listing/<id> on the platform host
 * permanently redirects to https://<domain>/listing/<id>. The path is NOT
 * root-mapped there (custom domains serve /listing/* via the proxy
 * passthrough), so the listing call site passes the full /listing/<id> path
 * as publicPath — no prefix stripping.
 */
import { resolveLiveSellerCustomDomainUrl } from "@/utils/db/custom-domains";

export async function resolvePlatformStallRedirect(args: {
  /**
   * True when the request is already served on the seller's custom domain
   * (proxy x-ss-custom-domain-host header, also set for self-host tenants) —
   * never redirect those, or the redirect would loop back onto itself.
   */
  servedOnCustomDomain: boolean;
  /**
   * Membership hidden flag (lapsed past the read-only window). Hidden
   * sellers' custom domains no longer resolve, so their stall keeps serving
   * on the platform URL instead.
   */
  sellerHidden: boolean;
  pubkey: string;
  /**
   * Public path BELOW the stall root ("" for the stall root itself,
   * "/blog/<post>" etc.). On a custom domain the stall is root-mapped, so
   * the /stall/<slug> prefix must be stripped, not carried over.
   */
  publicPath: string;
  /** Raw query string WITHOUT the leading "?" ("" when absent), preserved verbatim. */
  rawQuery: string;
}): Promise<string | null> {
  const { servedOnCustomDomain, sellerHidden, pubkey, publicPath, rawQuery } =
    args;
  if (servedOnCustomDomain || sellerHidden) return null;
  let customDomainOrigin: string | null;
  try {
    customDomainOrigin = await resolveLiveSellerCustomDomainUrl(pubkey);
  } catch (err) {
    // Fail OPEN (no redirect): a blip in the domain lookup must not take down
    // the platform stall page, which is still a perfectly good response.
    console.error("Custom-domain redirect lookup failed:", err);
    return null;
  }
  if (!customDomainOrigin) return null;
  return `${customDomainOrigin}${publicPath}${rawQuery ? `?${rawQuery}` : ""}`;
}
