import { NostrEvent } from "@/utils/types/types";
import { nip19 } from "nostr-tools";
import {
  getEffectiveShippingCost,
  parseShippingFromTags,
} from "@/utils/parsers/product-tag-helpers";
import { getListingSlug, type ListingSlugCandidate } from "@/utils/url-slugs";
import { toUcpMoney, type UcpMoney } from "./money";
import { resolveTaxonomy } from "./taxonomy";
import {
  UCP_VENDOR_NAMESPACE,
  type UcpAvailability,
  type UcpProduct,
  type UcpSeller,
  type UcpVariant,
} from "./types";

const DEFAULT_PLATFORM_URL = "https://milk.market";
const DEFAULT_PLACEHOLDER_IMAGE = "/milk-market.png";

function getTagValue(tags: string[][], key: string): string | undefined {
  const tag = tags.find((t) => t[0] === key);
  return tag ? tag[1] : undefined;
}

function getAllTagValues(tags: string[][], key: string): string[] {
  return tags
    .filter((t) => t[0] === key)
    .map((t) => t[1]!)
    .filter(Boolean);
}

/** A live inventory snapshot for one product (from inventory-service). */
export interface InventorySnapshot {
  default_quantity: number | null;
  variants: Record<string, number>;
}

export interface CatalogMapOptions {
  /** Absolute platform base URL used for relative images + fallback links. */
  platformUrl?: string;
  /**
   * When the catalog is scoped to a seller's custom domain, the seller's own
   * origin (e.g. "https://farmer.com"). Product/canonical URLs use this so links
   * stay on the seller's domain instead of pointing back at the platform.
   */
  sellerOrigin?: string;
  /** Precomputed friendly listing slug; falls back to the d-tag, then id. */
  listingSlug?: string;
  /**
   * Exact canonical page URL the visitor sees (friendly slug + custom-domain
   * origin). When provided it is used verbatim as the product's `url`, so
   * structured-data links match the page's canonical link tag instead of the
   * raw `/listing/{dTag|id}` identifier URL. Overrides `listingSlug`/origin.
   */
  canonicalUrl?: string;
  /** Live inventory snapshot; when omitted availability derives from the event. */
  inventory?: InventorySnapshot | null;
  /** Seller display name for the seller block. */
  sellerName?: string;
  /**
   * Accepted payment methods. Defaults to bitcoin-native methods that are always
   * available; callers that know a seller has Stripe Connect can pass the fuller
   * list (the single-product lookup does this).
   */
  paymentMethods?: string[];
}

/**
 * Conservative map of single-country ISO-4217 currencies to their ISO 3166-1
 * alpha-2 country code. Used to derive a truthful shipping destination from the
 * shipping rate's currency — the only structured destination signal a listing's
 * shipping config carries. Multi-country currencies (notably EUR) are
 * deliberately absent so we omit the destination rather than fabricate a region.
 */
const CURRENCY_TO_COUNTRY: Record<string, string> = {
  USD: "US",
  CAD: "CA",
  GBP: "GB",
  AUD: "AU",
  NZD: "NZ",
  JPY: "JP",
  CHF: "CH",
  MXN: "MX",
  BRL: "BR",
  INR: "IN",
  ZAR: "ZA",
  SEK: "SE",
  NOK: "NO",
  DKK: "DK",
  PLN: "PL",
  CZK: "CZ",
  HUF: "HU",
  SGD: "SG",
  HKD: "HK",
  KRW: "KR",
  THB: "TH",
  PHP: "PH",
  IDR: "ID",
  MYR: "MY",
  TRY: "TR",
  ILS: "IL",
};

/**
 * Derive the ISO 3166-1 alpha-2 country code(s) a shipping rate applies to from
 * its currency. Returns undefined for bitcoin/sats, blank, or multi-country
 * currencies so the caller omits the destination instead of inventing a region.
 */
function shippingDestinationCountries(
  currency: string | undefined
): string[] | undefined {
  const code = (currency || "").trim().toUpperCase();
  const country = CURRENCY_TO_COUNTRY[code];
  return country ? [country] : undefined;
}

function absoluteUrl(raw: string, base: string): string {
  if (!raw) return raw;
  if (/^https?:\/\//i.test(raw)) return raw;
  const path = raw.startsWith("/") ? raw : `/${raw}`;
  return `${base.replace(/\/$/, "")}${path}`;
}

function deriveAvailability(
  status: string | undefined,
  quantity: number | undefined,
  inventory: InventorySnapshot | null | undefined
): {
  availability: UcpAvailability;
  tracked: boolean;
  quantity: number | null;
} {
  // A live inventory snapshot is authoritative when present.
  if (inventory) {
    const variantTotals = Object.values(inventory.variants || {});
    const hasDefault = inventory.default_quantity !== null;
    const total =
      (hasDefault ? inventory.default_quantity! : 0) +
      variantTotals.reduce((a, b) => a + b, 0);
    const tracked = hasDefault || variantTotals.length > 0;
    if (tracked) {
      return {
        availability: total > 0 ? "in_stock" : "out_of_stock",
        tracked: true,
        quantity: total,
      };
    }
  }

  // No tracked inventory: fall back to the event's own signals. A "sold" status
  // or an explicit quantity of 0 means out of stock; otherwise the listing is
  // treated as available (untracked = available, matching the platform).
  if ((status || "").toLowerCase() === "sold") {
    return { availability: "out_of_stock", tracked: false, quantity: null };
  }
  if (quantity !== undefined && Number.isFinite(quantity)) {
    return {
      availability: quantity > 0 ? "in_stock" : "out_of_stock",
      tracked: true,
      quantity,
    };
  }
  return { availability: "in_stock", tracked: false, quantity: null };
}

function buildVariants(
  tags: string[][],
  basePrice: number,
  baseCurrency: string,
  inventory: InventorySnapshot | null | undefined,
  baseAvailable: boolean
): UcpVariant[] {
  const variants: UcpVariant[] = [];

  // Sizes carry per-variant inventory but share the base price.
  for (const t of tags) {
    if (t[0] !== "size" || !t[1]) continue;
    const value = t[1];
    const key = `size:${value}`;
    const tagQty = t[2] !== undefined ? Number(t[2]) : undefined;
    const invQty = inventory?.variants?.[key];
    const qty = invQty !== undefined ? invQty : tagQty;
    const available =
      qty !== undefined && Number.isFinite(qty) ? qty > 0 : baseAvailable;
    variants.push({
      id: key,
      title: value,
      attributes: { dimension: "size", value },
      price: toUcpMoney(basePrice, baseCurrency),
      available,
    });
  }

  // Volumes and weights carry their own price tiers.
  for (const t of tags) {
    if (t[0] === "volume" && t[1]) {
      const value = t[1];
      const price = t[2] !== undefined ? Number(t[2]) : basePrice;
      variants.push({
        id: `volume:${value}`,
        title: value,
        attributes: { dimension: "volume", value },
        price: toUcpMoney(price, baseCurrency),
        available: baseAvailable,
      });
    }
    if (t[0] === "weight" && t[1]) {
      const value = t[1];
      const price = t[2] !== undefined ? Number(t[2]) : basePrice;
      variants.push({
        id: `weight:${value}`,
        title: value,
        attributes: { dimension: "weight", value },
        price: toUcpMoney(price, baseCurrency),
        available: baseAvailable,
      });
    }
  }

  // Descriptive-only variants (no price/inventory of their own).
  for (const t of tags) {
    if (t[0] !== "variant" || !t[1]) continue;
    const value = t[1];
    variants.push({
      id: `variant:${value}`,
      title: value,
      attributes: { dimension: "variant", value },
      price: toUcpMoney(basePrice, baseCurrency),
      available: baseAvailable,
    });
  }

  return variants;
}

/**
 * Map a single NIP-99 (kind:30402) product event to the canonical UCP product
 * shape. Pure and synchronous: performs no DB or network calls. Availability is
 * derived from the event unless a live `inventory` snapshot is supplied.
 */
export function eventToUcpProduct(
  event: NostrEvent,
  opts: CatalogMapOptions = {}
): UcpProduct {
  const tags = event.tags || [];
  const platformUrl = (opts.platformUrl || DEFAULT_PLATFORM_URL).replace(
    /\/$/,
    ""
  );
  const linkBase = (opts.sellerOrigin || platformUrl).replace(/\/$/, "");

  const priceTag = tags.find((t) => t[0] === "price");
  const price = priceTag ? Number(priceTag[1]) : 0;
  const currency = priceTag ? priceTag[2] || "" : "";

  const title = getTagValue(tags, "title") || "";
  const summary = getTagValue(tags, "summary") || event.content || "";
  const categories = getAllTagValues(tags, "t");
  const location = getTagValue(tags, "location") || "";
  const status = getTagValue(tags, "status");
  const dTag = getTagValue(tags, "d");
  const quantity = getTagValue(tags, "quantity")
    ? Number(getTagValue(tags, "quantity"))
    : undefined;

  const slug = opts.listingSlug || dTag || event.id;
  const url = opts.canonicalUrl || `${linkBase}/listing/${slug}`;

  const rawImages = getAllTagValues(tags, "image");
  const images = (
    rawImages.length > 0 ? rawImages : [DEFAULT_PLACEHOLDER_IMAGE]
  ).map((img) => absoluteUrl(img, platformUrl));

  const {
    availability,
    tracked,
    quantity: invQty,
  } = deriveAvailability(status, quantity, opts.inventory);

  const parsedShipping = parseShippingFromTags(tags);
  const shippingType = parsedShipping?.shippingType || "N/A";
  const effectiveShippingCost = getEffectiveShippingCost(
    shippingType,
    parsedShipping?.shippingCost
  );
  const shippingCurrency = parsedShipping?.shippingCurrency || currency;
  const shippingCost: UcpMoney | null =
    effectiveShippingCost === null
      ? null
      : toUcpMoney(effectiveShippingCost, shippingCurrency);
  const pickupAvailable = /pickup/i.test(shippingType);
  const pickupLocations = getAllTagValues(tags, "pickup_location");
  // Destination is derived ONLY from a real, valid shipping tag's own currency
  // (never the price-currency fallback) and only when a concrete cost exists.
  // "N/A" is an allowed shipping type that means "no shipping config", so it is
  // explicitly excluded — a listing with no/unknown shipping claims no region
  // rather than fabricating one.
  const destinationCountries =
    parsedShipping &&
    parsedShipping.shippingType !== "N/A" &&
    shippingCost !== null
      ? shippingDestinationCountries(parsedShipping.shippingCurrency)
      : undefined;

  const taxonomy = resolveTaxonomy({
    categories,
    googleOverride: getTagValue(tags, "google_product_category"),
    shopifyOverride: getTagValue(tags, "shopify_product_category"),
  });

  const variants = buildVariants(
    tags,
    price,
    currency,
    opts.inventory,
    availability === "in_stock"
  );

  const seller: UcpSeller = {
    pubkey: event.pubkey,
    npub: safeNpub(event.pubkey),
  };
  if (opts.sellerName) seller.name = opts.sellerName;

  const subscriptionEnabled = getTagValue(tags, "subscription") === "true";
  const subscriptionDiscount = getTagValue(tags, "subscription_discount");
  const subscriptionFreq = tags.find((t) => t[0] === "subscription_frequency");

  const product: UcpProduct = {
    id: event.id,
    type: "product",
    title,
    description: summary,
    url,
    images,
    price: toUcpMoney(price, currency),
    categories,
    availability,
    inventory: { tracked, quantity: invQty },
    seller,
    shipping: {
      type: shippingType,
      cost: shippingCost,
      pickupAvailable,
      ...(pickupLocations.length > 0 ? { pickupLocations } : {}),
      ...(destinationCountries ? { destinationCountries } : {}),
    },
    paymentMethods: opts.paymentMethods || ["lightning", "cashu"],
    updatedAt: new Date((event.created_at || 0) * 1000).toISOString(),
    ext: {
      [UCP_VENDOR_NAMESPACE]: {
        eventId: event.id,
        ...(dTag ? { dTag } : {}),
        ...(status ? { status } : {}),
        nativeCurrency: currency || "sats",
        nativePrice: price,
      },
    },
  };

  if (location) product.location = location;
  if (Object.keys(taxonomy).length > 0) product.taxonomy = taxonomy;
  if (variants.length > 0) product.variants = variants;
  if (subscriptionEnabled) {
    product.subscription = {
      enabled: true,
      ...(subscriptionDiscount
        ? { discountPercent: Number(subscriptionDiscount) }
        : {}),
      frequencies: subscriptionFreq ? subscriptionFreq.slice(1) : [],
    };
  }

  return product;
}

function safeNpub(pubkey: string): string {
  try {
    return nip19.npubEncode(pubkey);
  } catch {
    return pubkey;
  }
}

/**
 * Map a set of product events to UCP products, computing friendly listing slugs
 * per seller (so canonical URLs match the storefront's). Used by the MCP catalog
 * resource and the REST catalog endpoints so all three share one representation.
 */
export function buildUcpCatalog(
  events: NostrEvent[],
  opts: Omit<CatalogMapOptions, "listingSlug" | "inventory" | "sellerName"> & {
    sellerNames?: Map<string, string>;
  } = {}
): UcpProduct[] {
  // Group events by seller so slug disambiguation is scoped per storefront.
  const bySeller = new Map<string, NostrEvent[]>();
  for (const ev of events) {
    const list = bySeller.get(ev.pubkey) || [];
    list.push(ev);
    bySeller.set(ev.pubkey, list);
  }

  const out: UcpProduct[] = [];
  for (const [pubkey, sellerEvents] of bySeller.entries()) {
    const candidates: ListingSlugCandidate[] = sellerEvents.map((ev) => ({
      id: ev.id,
      title: getTagValue(ev.tags || [], "title") || "",
      pubkey: ev.pubkey,
    }));
    for (const ev of sellerEvents) {
      const candidate = candidates.find((c) => c.id === ev.id)!;
      out.push(
        eventToUcpProduct(ev, {
          platformUrl: opts.platformUrl,
          sellerOrigin: opts.sellerOrigin,
          paymentMethods: opts.paymentMethods,
          listingSlug: getListingSlug(candidate, candidates),
          sellerName: opts.sellerNames?.get(pubkey),
        })
      );
    }
  }
  return out;
}
