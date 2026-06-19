import { UcpMoney } from "./money";
import { ProductTaxonomy } from "./taxonomy";

/**
 * Shared type + namespace definitions for the Universal Commerce Protocol (UCP)
 * layer. These shapes are the single canonical representation of a Milk Market
 * listing for agentic clients; the MCP catalog resource and the REST catalog
 * endpoints both emit them via the shared mapper in `catalog.ts`, so the two can
 * never drift.
 */

/** Standard UCP capability namespace (Google + Shopify). */
export const UCP_NAMESPACE = "dev.ucp.shopping";
export const UCP_CATALOG_CAPABILITY = `${UCP_NAMESPACE}.catalog`;
export const UCP_CHECKOUT_CAPABILITY = `${UCP_NAMESPACE}.checkout`;
export const UCP_VERSION = "2025-draft";

/**
 * Vendor extension namespace (reverse-DNS of milk.market) for fields that are
 * Milk Market / Nostr specific and have no standard UCP equivalent (event id,
 * seller npub, d-tag, herdshare terms, etc).
 */
export const UCP_VENDOR_NAMESPACE = "market.milk";

export type UcpAvailability =
  | "in_stock"
  | "out_of_stock"
  | "preorder"
  | "unknown";

export interface UcpSeller {
  /** Nostr pubkey (hex) — the stable seller identifier. */
  pubkey: string;
  /** Bech32 npub encoding of the pubkey. */
  npub: string;
  /** Display name from the seller's profile, when known. */
  name?: string;
  /** Absolute storefront URL, when known. */
  url?: string;
}

export interface UcpShipping {
  /** Milk Market shipping option (Pickup, Free, Added Cost, …). */
  type: string;
  /** Shipping cost as money, or null when not quotable up front. */
  cost: UcpMoney | null;
  /** True when local pickup is offered. */
  pickupAvailable: boolean;
  /** Free-form pickup locations, when listed. */
  pickupLocations?: string[];
  /**
   * ISO 3166-1 alpha-2 country code(s) the shipping rate applies to, derived
   * from the shipping currency (the only structured destination signal in the
   * listing's real shipping config). Omitted when it can't be stated truthfully
   * — e.g. bitcoin-priced shipping or a multi-country currency like EUR — so we
   * never fabricate a region.
   */
  destinationCountries?: string[];
}

export interface UcpVariant {
  /** Stable variant key, e.g. "size:1 Gallon" or "volume:1 qt". */
  id: string;
  /** Human label for the option value. */
  title: string;
  /** Structured option attributes, e.g. { dimension: "size", value: "1 Gallon" }. */
  attributes: Record<string, string>;
  /** Variant price (may differ from base for volume/weight tiers). */
  price: UcpMoney;
  /** Whether this specific variant is purchasable. */
  available: boolean;
}

export interface UcpSubscription {
  enabled: boolean;
  discountPercent?: number;
  frequencies: string[];
}

export interface UcpProduct {
  id: string;
  type: "product";
  title: string;
  description: string;
  /** Absolute canonical product URL (host-scoped for seller domains). */
  url: string;
  /** Absolute image URLs. */
  images: string[];
  price: UcpMoney;
  categories: string[];
  taxonomy?: ProductTaxonomy;
  availability: UcpAvailability;
  inventory?: { tracked: boolean; quantity: number | null };
  seller: UcpSeller;
  location?: string;
  shipping: UcpShipping;
  /** Accepted payment methods (always lightning + cashu; stripe when enabled). */
  paymentMethods: string[];
  variants?: UcpVariant[];
  subscription?: UcpSubscription;
  /** RFC3339 last-updated timestamp (from the Nostr event created_at). */
  updatedAt: string;
  /** Vendor extension block, keyed under the reverse-DNS namespace. */
  ext: Record<string, unknown>;
}

export interface UcpCatalogPage {
  count: number;
  products: UcpProduct[];
}
