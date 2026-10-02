import type { UcpProduct } from "@/utils/ucp/types";
import type { UcpMoney } from "@/utils/ucp/money";
import { UCP_BITCOIN_CURRENCY } from "@/utils/ucp/money";
import { nip19 } from "nostr-tools";

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
 * Build the schema.org offers node for a product: a single `Offer` at the base
 * price, or an `AggregateOffer` (lowPrice→highPrice + offerCount) when variant
 * tiers (volume/weight) price differently, so agents can read a variant price
 * RANGE without scraping. Fiat-only: bitcoin/sats prices use the unofficial
 * "XBT" code Google's Product markup rejects, so a bitcoin-priced listing's
 * offer carries url + availability but no price. Shipping details are NOT
 * attached here — the single-product page adds them; the stall ItemList embed
 * keeps offers lean.
 */
export function buildProductOfferJsonLd(
  product: UcpProduct
): Record<string, unknown> {
  const sellerName = product.seller.name || "Self-sown seller";

  const base: Record<string, unknown> = {
    url: product.url,
    itemCondition: "https://schema.org/NewCondition",
    seller: { "@type": "Organization", name: sellerName },
  };

  const availability = AVAILABILITY_MAP[product.availability];
  if (availability) base.availability = availability;

  // Every fiat price point (base + variant tiers) in the base currency. A
  // spread means variants price differently → AggregateOffer. (Variants always
  // inherit the base currency from the catalog mapper; the filter is just
  // defensive against a mixed-currency hand-built product.)
  const fiatPrices: UcpMoney[] = [];
  if (isFiatMoney(product.price)) fiatPrices.push(product.price);
  for (const variant of product.variants ?? []) {
    if (
      isFiatMoney(variant.price) &&
      variant.price.currency === product.price.currency
    ) {
      fiatPrices.push(variant.price);
    }
  }
  const distinctAmounts = [...new Set(fiatPrices.map((m) => m.amount))];

  if (distinctAmounts.length > 1) {
    const template = fiatPrices[0]!;
    return {
      "@type": "AggregateOffer",
      ...base,
      priceCurrency: template.currency,
      lowPrice: moneyToPriceString({
        ...template,
        amount: Math.min(...distinctAmounts),
      }),
      highPrice: moneyToPriceString({
        ...template,
        amount: Math.max(...distinctAmounts),
      }),
      offerCount: (product.variants?.length ?? 0) + 1,
    };
  }

  const offer: Record<string, unknown> = { "@type": "Offer", ...base };
  if (isFiatMoney(product.price)) {
    offer.price = moneyToPriceString(product.price);
    offer.priceCurrency = product.price.currency;
  }
  return offer;
}

/**
 * Build a schema.org Product node (with a nested Offer) from a UCP product.
 * Returns a plain object; serialize with `safeJsonLdString` before embedding.
 */
export function buildProductJsonLd(
  product: UcpProduct
): Record<string, unknown> {
  const offer = buildProductOfferJsonLd(product);

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
 * Build a schema.org ItemList node linking to a storefront's products. Each
 * ListItem embeds a compact Product summary (name/url/image + an Offer or
 * AggregateOffer with fiat price and availability) so agents can read prices
 * straight from the stall homepage without scraping each product page; the
 * full Product node (description, shipping, taxonomy) stays on the product
 * page itself. Bounded by the caller's slice — the Products stay NESTED inside
 * the ItemList (never a top-level Product script, which would duplicate the
 * product page's markup).
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
    itemListElement: products.map((p, i) => {
      const item: Record<string, unknown> = {
        "@type": "Product",
        name: p.title || "Self-sown Listing",
        url: p.url,
        offers: buildProductOfferJsonLd(p),
      };
      if (p.images.length > 0) item.image = p.images[0];
      return {
        "@type": "ListItem",
        position: i + 1,
        url: p.url,
        name: p.title || "Self-sown Listing",
        item,
      };
    }),
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
 * THE single builder for a stall's schema.org Store identity node, shared by
 * every stall SSR branch (homepage product-landing / Pro / non-Pro, and the
 * subpage equivalents in pages/stall/[...stallPath].tsx). Do NOT call
 * buildSellerIdentityJsonLd directly from stall pages — a second call site
 * with its own fallback chain is exactly the drift this helper exists to
 * prevent (the same shop must tell search engines the same thing on every
 * page that gets crawled).
 *
 * One fallback policy for all branches:
 *   name        = branding.shopName || ssrShopName || nameFallback
 *   description = branding.about    || ssrShopAbout || (omitted)
 *   image       = branding.image    || (omitted — never SSR-derived)
 *   sameAs      = njump link for the seller's npub (derived from pubkey here
 *                 so every branch shares one npub-encoding policy)
 *
 * `branding` is the resolved Pro branding (resolveStallBranding) and is passed
 * only by Pro branches; non-Pro branches omit it and get the minimal
 * SSR-derived identity. `nameFallback` (slug or page title) is the last-resort
 * name so the node never emits an empty name.
 */
export function buildStallStoreIdentityJsonLd(opts: {
  /** Canonical stall home URL for the request (custom-domain aware). */
  url: string;
  /** Resolved Pro branding; omit for the minimal non-Pro identity. */
  branding?: { shopName?: string; about?: string; image?: string } | null;
  /** Shop name extracted from the shop/profile events (all sellers). */
  ssrShopName?: string;
  /** Shop about extracted from the shop event (all sellers). */
  ssrShopAbout?: string;
  /** Last-resort name when neither branding nor SSR produced one. */
  nameFallback: string;
  /** Seller pubkey (hex) — npub sameAs link is derived here. */
  pubkey?: string;
}): Record<string, unknown> {
  let npub = "";
  if (opts.pubkey) {
    try {
      npub = nip19.npubEncode(opts.pubkey);
    } catch {
      npub = "";
    }
  }
  return buildSellerIdentityJsonLd({
    name: opts.branding?.shopName || opts.ssrShopName || opts.nameFallback,
    url: opts.url,
    description: opts.branding?.about || opts.ssrShopAbout || undefined,
    image: opts.branding?.image || undefined,
    npub: npub || undefined,
  });
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

/**
 * Shared stall-subpage breadcrumb (Home > <Subpage> [> <leaf>]) so every
 * branch of pages/stall/[...stallPath].tsx (Pro, non-Pro, blog index,
 * single post) emits the SAME node: one name fallback ("Shop"), one
 * capitalization rule, one URL derivation. Editing breadcrumb behavior here
 * updates all branches at once — never rebuild the item list inline.
 */
export function buildStallBreadcrumbJsonLd(opts: {
  /** Canonical stall home URL for the request (custom-domain aware). */
  homeUrl: string;
  /** Stall display name (branding- or SSR-resolved); falls back to "Shop". */
  shopName?: string;
  /** Subpage key (e.g. "blog", "shop") — label is capitalized here. */
  subPage: string;
  /** Optional leaf item (e.g. a blog post) appended under the subpage. */
  leaf?: { name: string; url: string };
}): Record<string, unknown> {
  const items: { name: string; url: string }[] = [
    { name: opts.shopName || "Shop", url: opts.homeUrl },
    {
      name: opts.subPage.charAt(0).toUpperCase() + opts.subPage.slice(1),
      url: `${opts.homeUrl}/${opts.subPage}`,
    },
  ];
  if (opts.leaf) items.push(opts.leaf);
  return buildBreadcrumbJsonLd(items);
}
