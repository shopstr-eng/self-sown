import type { NextApiRequest } from "next";
import { nip19 } from "nostr-tools";
import {
  fetchCachedEvents,
  getDbPool,
  getStripeConnectAccount,
} from "@/utils/db/db-service";
import { getMembershipView } from "@/utils/pro/membership";
import { getSelfHostConfig, isSelfHost } from "@/utils/self-host/config";

/**
 * Server-only resolver that maps an inbound request to a UCP host scope. This is
 * the single security-sensitive place where a seller is bound to a host, shared
 * by the discovery profile and the REST catalog endpoints so they can't drift.
 *
 * SECURITY — resolve, never trust a supplied pubkey:
 *   - Self-host: the one tenant comes from server env (MM_SELF_HOST*).
 *   - Custom domain: the owning seller is resolved from the request *domain*
 *     against the verified `custom_domains` table and run through the hidden-
 *     membership gate (mirrors /api/storefront/nostr-json). A lapsed/hidden
 *     seller resolves to nothing, so the host advertises no scoped surface.
 *   - The forgeable `x-mm-shop-pubkey` header is never used for scoping.
 */

export interface ScopedSeller {
  /** Nostr pubkey (hex). */
  pubkey: string;
  /** Bech32 npub. */
  npub: string;
  /** Seller display name, when known. */
  name?: string;
  /** Storefront slug, when known. */
  slug?: string;
}

export interface HostScope {
  scope: "marketplace" | "seller";
  seller: ScopedSeller | null;
  /**
   * True when the request targeted a seller host (custom domain or self-host)
   * but no valid seller resolved (unconfigured/hidden). Callers should 404.
   */
  unresolved: boolean;
}

const pool = getDbPool();

function headerValue(req: NextApiRequest, name: string): string {
  const raw = req.headers[name];
  return typeof raw === "string" ? raw : "";
}

/** Absolute base URL for the host this request came in on. */
export function deriveBaseUrl(req: NextApiRequest): string {
  const customHost = headerValue(req, "x-mm-custom-domain-host");
  const host = (customHost || req.headers.host || "").toLowerCase().trim();
  if (host && !host.startsWith("localhost") && !host.startsWith("127.")) {
    return `https://${host.replace(/:\d+$/, "")}`;
  }
  return process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:5000";
}

/** Resolve the seller (if any) this host is scoped to. */
export async function resolveHostScope(
  req: NextApiRequest
): Promise<HostScope> {
  // 1) Self-host: a single-tenant instance is always seller-scoped, sourced
  //    from server env (authoritative, not a header).
  if (isSelfHost()) {
    const cfg = getSelfHostConfig();
    if (!cfg.tenantPubkey) {
      return { scope: "seller", seller: null, unresolved: true };
    }
    const seller = await buildSellerScope(cfg.tenantPubkey, cfg.tenantSlug);
    return { scope: "seller", seller, unresolved: false };
  }

  // 2) Custom domain: resolve + membership-gate the owning seller from the
  //    verified domain.
  const customHost = headerValue(req, "x-mm-custom-domain-host");
  if (customHost) {
    const domain = customHost.toLowerCase().trim().replace(/:\d+$/, "");
    const seller = await resolveSellerByDomain(domain);
    return { scope: "seller", seller, unresolved: !seller };
  }

  // 3) Platform host: aggregate marketplace scope.
  return { scope: "marketplace", seller: null, unresolved: false };
}

async function resolveSellerByDomain(
  domain: string
): Promise<ScopedSeller | null> {
  if (!domain) return null;
  const result = await pool.query(
    "SELECT pubkey FROM custom_domains WHERE domain = $1 AND verified = true",
    [domain]
  );
  if (result.rows.length === 0) return null;
  const pubkey = String(result.rows[0].pubkey).toLowerCase();
  const view = await getMembershipView(pubkey);
  if (view.isHidden) return null;
  return buildSellerScope(pubkey, null);
}

async function buildSellerScope(
  pubkey: string,
  slug: string | null
): Promise<ScopedSeller> {
  const seller: ScopedSeller = {
    pubkey,
    npub: safeNpub(pubkey),
  };
  if (slug) seller.slug = slug;
  const name = await fetchSellerName(pubkey);
  if (name) seller.name = name;
  return seller;
}

/**
 * Resolve display names for a bounded set of seller pubkeys (kind:0). Used to
 * enrich a single page of catalog results, so the number of lookups is capped by
 * the page size rather than the whole marketplace.
 */
export async function fetchSellerNames(
  pubkeys: string[]
): Promise<Map<string, string>> {
  const unique = Array.from(new Set(pubkeys.filter(Boolean)));
  const map = new Map<string, string>();
  await Promise.all(
    unique.map(async (pk) => {
      const name = await fetchSellerName(pk);
      if (name) map.set(pk, name);
    })
  );
  return map;
}

async function fetchSellerName(pubkey: string): Promise<string> {
  try {
    const events = await fetchCachedEvents(0, { pubkey, limit: 1 });
    const event = events[0];
    if (!event) return "";
    const content = JSON.parse(event.content) as {
      display_name?: unknown;
      name?: unknown;
    };
    if (
      typeof content.display_name === "string" &&
      content.display_name.trim()
    ) {
      return content.display_name.trim();
    }
    if (typeof content.name === "string") return content.name.trim();
    return "";
  } catch {
    return "";
  }
}

/**
 * Accepted payment methods for a given seller. Bitcoin-native methods are always
 * available; card (Stripe) is added only when the seller has a Connect account
 * with charges enabled (or, on a self-host instance, the owner runs own-Stripe).
 */
export async function resolveSellerPaymentMethods(
  pubkey: string
): Promise<string[]> {
  const methods = ["lightning", "cashu"];
  try {
    if (isSelfHost()) {
      const cfg = getSelfHostConfig();
      if (
        cfg.tenantPubkey === pubkey.toLowerCase() &&
        cfg.ownStripe &&
        process.env.STRIPE_SECRET_KEY
      ) {
        methods.push("stripe");
      }
      return methods;
    }
    const account = await getStripeConnectAccount(pubkey);
    if (account?.charges_enabled) methods.push("stripe");
  } catch {
    // Fail soft: a status lookup error just omits the card option.
  }
  return methods;
}

function safeNpub(pubkey: string): string {
  try {
    return nip19.npubEncode(pubkey);
  } catch {
    return pubkey;
  }
}
