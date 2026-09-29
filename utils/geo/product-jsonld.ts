import type { UcpProduct } from "@/utils/ucp/types";
import type { UcpMoney } from "@/utils/ucp/money";
import { UCP_BITCOIN_CURRENCY } from "@/utils/ucp/money";

/**
 * schema.org JSON-LD builders for GEO / AI-shopping discovery.
 *
 * These turn the SAME canonical `UcpProduct` (utils/ucp/catalog.ts) that the MCP
 * and UCP catalog surfaces emit into schema.org `Product`/`Offer`/`ItemList`
 * nodes, so the structured data crawlers see can never drift from what agents
 * see. Built server-side in getServerSideProps and rendered in <head> via
 * DynamicHead (routed through `safeJsonLdString`).
 *
 * Deliberately conservative — we only emit fields we can state truthfully from
 * listing data:
 *   - price/priceCurrency ONLY for ISO-4217 fiat. Bitcoin/sats prices use the
 *     unofficial "XBT" code which Google's Product markup rejects, and we never
 *     convert sats↔fiat (see utils/ucp/money.ts). For bitcoin-priced listings
 *     the Offer is still emitted (url + availability) without a price.
 *   - shippingDetails ONLY when a concrete fiat shipping rate is known.
 *   - NO aggregateRating/review (reviews aren't rendered server-side; emitting
 *     unseen ratings would violate Google's review-snippet policy), and NO
 *     MerchantReturnPolicy / openingHours (no structured per-seller data).
 */

const SCHEMA_CONTEXT = "https://schema.org";

const AVAILABILITY_MAP: Record<string, string | undefined> = {
  in_stock: "https://schema.org/InStock",
  out_of_stock: "https://schema.org/OutOfStock",
  preorder: "https://schema.org/PreOrder",
  unknown: undefined,
};

/** True for an ISO-4217 fiat amount Google will accept (not bitcoin/sats). */
function isFiatMoney(money: UcpMoney | null | undefined): money is UcpMoney {
  if (!money || !money.currency) return false;
  if (money.currency === UCP_BITCOIN_CURRENCY) return false;
  return /^[A-Z]{3}$/.test(money.currency);
}

/** Format an integer minor-unit amount as a decimal string in major units. */
export function moneyToPriceString(money: UcpMoney): string {
  const major = money.amount / Math.pow(10, money.exponent);
  return money.exponent > 0
    ? major.toFixed(money.exponent)
    : String(Math.round(major));
}

/**
 * Build a schema.org Product node (with a nested Offer) from a UCP product.
 * Returns a plain object; serialize with `safeJsonLdString` before embedding.
 */
export function buildProductJsonLd(
  product: UcpProduct
): Record<string, unknown> {
  const sellerName = product.seller.name || "Self-sown seller";

  const offer: Record<string, unknown> = {
    "@type": "Offer",
    url: product.url,
    itemCondition: "https://schema.org/NewCondition",
    seller: { "@type": "Organization", name: sellerName },
  };

  const availability = AVAILABILITY_MAP[product.availability];
  if (availability) offer.availability = availability;

  if (isFiatMoney(product.price)) {
    offer.price = moneyToPriceString(product.price);
    offer.priceCurrency = product.price.currency;
  }

  if (isFiatMoney(product.shipping?.cost)) {
    const shippingDetails: Record<string, unknown> = {
      "@type": "OfferShippingDetails",
      shippingRate: {
        "@type": "MonetaryAmount",
        value: moneyToPriceString(product.shipping!.cost!),
        currency: product.shipping!.cost!.currency,
      },
    };

    // Google's product rich results need a destination to display the shipping
    // cost. Emit a DefinedRegion per ISO-3166-1 country the rate applies to,
    // straight from the seller's real shipping config (derived in catalog.ts) —
    // omitted entirely when none is known so we never fabricate a region.
    const destinations = product.shipping?.destinationCountries;
    if (destinations && destinations.length > 0) {
      const regions = destinations.map((country) => ({
        "@type": "DefinedRegion",
        addressCountry: country,
      }));
      shippingDetails.shippingDestination =
        regions.length === 1 ? regions[0] : regions;

      // Handling time comes from the seller's own `handling_time` listing tag
      // (whole days until ship-out). It is only emitted alongside a valid rate
      // AND destination — Google requires both on OfferShippingDetails, so a
      // deliveryTime-only block would be ignored rather than enrich anything.
      // Transit time is NOT emitted: the only transit data is live per-quote
      // Shippo estimates keyed to a buyer's destination, which can't be
      // truthfully stated on a crawler-facing page.
      const handlingTimeDays = product.shipping?.handlingTimeDays;
      if (handlingTimeDays !== undefined) {
        shippingDetails.deliveryTime = {
          "@type": "ShippingDeliveryTime",
          handlingTime: {
            "@type": "QuantitativeValue",
            minValue: handlingTimeDays,
            maxValue: handlingTimeDays,
            unitCode: "DAY",
          },
        };
      }
    }

    offer.shippingDetails = shippingDetails;
  }

  const node: Record<string, unknown> = {
    "@context": SCHEMA_CONTEXT,
    "@type": "Product",
    name: product.title || "Self-sown Listing",
    url: product.url,
    sku: product.id,
    brand: { "@type": "Brand", name: product.seller.name || "Self-sown" },
    offers: offer,
  };

  if (product.description) node.description = product.description;
  if (product.images.length > 0) node.image = product.images;

  const category = product.taxonomy?.google || product.categories[0];
  if (category) node.category = category;

  return node;
}

/**
 * Build a schema.org ItemList node linking to a storefront's products. Kept
 * lightweight (ListItem url + name) and bounded by the caller's slice; this is
 * for crawler discovery of a stall's catalog, not a full product feed.
 */
export function buildItemListJsonLd(
  products: UcpProduct[],
  opts: { url: string; name?: string }
): Record<string, unknown> {
  const node: Record<string, unknown> = {
    "@context": SCHEMA_CONTEXT,
    "@type": "ItemList",
    url: opts.url,
    numberOfItems: products.length,
    itemListElement: products.map((p, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: p.url,
      name: p.title || "Self-sown Listing",
    })),
  };
  if (opts.name) node.name = opts.name;
  return node;
}

/**
 * schema.org Store node identifying the SELLER behind a stall page — the
 * custom-domain counterpart of the platform's global Organization/WebSite
 * nodes. Uses the seller's own branding (name/about/image) and canonical
 * stall URL, with sameAs pointing at their Nostr identity so agents can
 * cross-check who operates the shop. Distinct from the platform Organization
 * node: a stall page intentionally emits BOTH (platform runs the marketplace,
 * seller runs the store).
 */
export function buildSellerIdentityJsonLd(opts: {
  name: string;
  url: string;
  description?: string;
  image?: string;
  /** Seller's Nostr npub (bech32), used for a sameAs identity link. */
  npub?: string;
}): Record<string, unknown> {
  const node: Record<string, unknown> = {
    "@context": SCHEMA_CONTEXT,
    "@type": "Store",
    name: opts.name,
    url: opts.url,
  };
  if (opts.description) node.description = opts.description;
  if (opts.image) node.image = opts.image;
  const sameAs: string[] = [];
  if (opts.npub) sameAs.push(`https://njump.me/${opts.npub}`);
  if (sameAs.length > 0) node.sameAs = sameAs;
  return node;
}

/**
 * schema.org BreadcrumbList for stall subpages (e.g. Home > Blog) so crawlers
 * and agents understand the page hierarchy on BOTH the platform stall path
 * and the seller's custom domain. `items` is ordered root → leaf.
 */
export function buildBreadcrumbJsonLd(
  items: { name: string; url: string }[]
): Record<string, unknown> {
  return {
    "@context": SCHEMA_CONTEXT,
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: item.url,
    })),
  };
}
