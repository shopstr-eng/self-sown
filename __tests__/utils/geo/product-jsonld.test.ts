/** @jest-environment node */

// Unit coverage for the GEO JSON-LD builders (utils/geo/product-jsonld.ts).
// These turn the canonical UcpProduct into schema.org Product/Offer/ItemList
// nodes embedded server-side for crawlers and AI shopping agents. The builder is
// deliberately conservative: fiat-only Offer price (Google rejects the "XBT"
// bitcoin code and we never convert sats<->fiat), shippingDetails only when a
// fiat rate is known, and NO fabricated review/return/hours data.

import {
  buildProductJsonLd,
  buildItemListJsonLd,
  moneyToPriceString,
} from "@/utils/geo/product-jsonld";
import { UCP_BITCOIN_CURRENCY } from "@/utils/ucp/money";
import type { UcpMoney } from "@/utils/ucp/money";
import type { UcpProduct } from "@/utils/ucp/types";

const usd = (amount: number): UcpMoney => ({
  currency: "USD",
  amount,
  exponent: 2,
  display: (amount / 100).toFixed(2),
});

const sats = (amount: number): UcpMoney => ({
  currency: UCP_BITCOIN_CURRENCY,
  amount,
  exponent: 8,
  display: `${amount} sat`,
});

function makeProduct(overrides: Partial<UcpProduct> = {}): UcpProduct {
  return {
    id: "evt-1",
    type: "product",
    title: "Raw Milk",
    description: "Fresh from the farm",
    url: "https://milk.market/listing/raw-milk",
    images: ["https://cdn.example/a.png", "https://cdn.example/b.png"],
    price: usd(1200),
    categories: ["milk"],
    availability: "in_stock",
    inventory: { tracked: true, quantity: 5 },
    seller: {
      pubkey: "00".repeat(32),
      npub: "npub1seller",
      name: "St. John Creamery",
    },
    shipping: { type: "Free", cost: usd(0), pickupAvailable: false },
    paymentMethods: ["lightning", "cashu"],
    updatedAt: "2026-01-01T00:00:00.000Z",
    ext: {},
    ...overrides,
  };
}

describe("buildProductJsonLd", () => {
  it("emits a Product with core fields and a fiat Offer", () => {
    const ld = buildProductJsonLd(makeProduct());

    expect(ld["@context"]).toBe("https://schema.org");
    expect(ld["@type"]).toBe("Product");
    expect(ld.name).toBe("Raw Milk");
    expect(ld.url).toBe("https://milk.market/listing/raw-milk");
    expect(ld.sku).toBe("evt-1");
    expect(ld.description).toBe("Fresh from the farm");
    expect(ld.image).toEqual([
      "https://cdn.example/a.png",
      "https://cdn.example/b.png",
    ]);
    expect(ld.brand).toEqual({ "@type": "Brand", name: "St. John Creamery" });

    const offer = ld.offers as Record<string, unknown>;
    expect(offer["@type"]).toBe("Offer");
    expect(offer.url).toBe("https://milk.market/listing/raw-milk");
    expect(offer.itemCondition).toBe("https://schema.org/NewCondition");
    expect(offer.seller).toEqual({
      "@type": "Organization",
      name: "St. John Creamery",
    });
    expect(offer.price).toBe("12.00");
    expect(offer.priceCurrency).toBe("USD");
    expect(offer.availability).toBe("https://schema.org/InStock");
  });

  it("omits price/priceCurrency for bitcoin (XBT) listings but keeps the Offer", () => {
    const ld = buildProductJsonLd(
      makeProduct({
        price: sats(1500),
        shipping: { type: "Free", cost: sats(0), pickupAvailable: false },
      })
    );
    const offer = ld.offers as Record<string, unknown>;
    expect(offer.price).toBeUndefined();
    expect(offer.priceCurrency).toBeUndefined();
    // The Offer is still present with url + availability so the listing is
    // discoverable; it simply carries no Google-invalid price.
    expect(offer.url).toBe("https://milk.market/listing/raw-milk");
    expect(offer.availability).toBe("https://schema.org/InStock");
    expect(offer.shippingDetails).toBeUndefined();
  });

  it("maps each availability state to the schema.org URL (and omits unknown)", () => {
    const states: Array<[UcpProduct["availability"], string | undefined]> = [
      ["in_stock", "https://schema.org/InStock"],
      ["out_of_stock", "https://schema.org/OutOfStock"],
      ["preorder", "https://schema.org/PreOrder"],
      ["unknown", undefined],
    ];
    for (const [availability, expected] of states) {
      const ld = buildProductJsonLd(makeProduct({ availability }));
      const offer = ld.offers as Record<string, unknown>;
      expect(offer.availability).toBe(expected);
    }
  });

  it("adds shippingDetails only when a fiat shipping cost is known", () => {
    const withCost = buildProductJsonLd(
      makeProduct({
        shipping: {
          type: "Added Cost",
          cost: usd(599),
          pickupAvailable: false,
        },
      })
    );
    const offer = withCost.offers as Record<string, unknown>;
    expect(offer.shippingDetails).toEqual({
      "@type": "OfferShippingDetails",
      shippingRate: {
        "@type": "MonetaryAmount",
        value: "5.99",
        currency: "USD",
      },
    });

    const noCost = buildProductJsonLd(
      makeProduct({
        shipping: { type: "Pickup", cost: null, pickupAvailable: true },
      })
    );
    expect(
      (noCost.offers as Record<string, unknown>).shippingDetails
    ).toBeUndefined();
  });

  it("emits a single DefinedRegion shippingDestination from the country code", () => {
    const ld = buildProductJsonLd(
      makeProduct({
        shipping: {
          type: "Added Cost",
          cost: usd(599),
          pickupAvailable: false,
          destinationCountries: ["US"],
        },
      })
    );
    const details = (ld.offers as Record<string, unknown>)
      .shippingDetails as Record<string, unknown>;
    expect(details.shippingDestination).toEqual({
      "@type": "DefinedRegion",
      addressCountry: "US",
    });
  });

  it("emits an array of DefinedRegions when shipping to multiple countries", () => {
    const ld = buildProductJsonLd(
      makeProduct({
        shipping: {
          type: "Added Cost",
          cost: usd(599),
          pickupAvailable: false,
          destinationCountries: ["US", "CA"],
        },
      })
    );
    const details = (ld.offers as Record<string, unknown>)
      .shippingDetails as Record<string, unknown>;
    expect(details.shippingDestination).toEqual([
      { "@type": "DefinedRegion", addressCountry: "US" },
      { "@type": "DefinedRegion", addressCountry: "CA" },
    ]);
  });

  it("omits shippingDestination when no destination is known (no fabrication)", () => {
    const noDestination = buildProductJsonLd(
      makeProduct({
        shipping: {
          type: "Added Cost",
          cost: usd(599),
          pickupAvailable: false,
        },
      })
    );
    const details = (noDestination.offers as Record<string, unknown>)
      .shippingDetails as Record<string, unknown>;
    expect(details.shippingDestination).toBeUndefined();

    const emptyDestination = buildProductJsonLd(
      makeProduct({
        shipping: {
          type: "Added Cost",
          cost: usd(599),
          pickupAvailable: false,
          destinationCountries: [],
        },
      })
    );
    expect(
      (
        (emptyDestination.offers as Record<string, unknown>)
          .shippingDetails as Record<string, unknown>
      ).shippingDestination
    ).toBeUndefined();
  });

  it("never fabricates review, rating, return-policy or hours data", () => {
    const ld = buildProductJsonLd(makeProduct());
    expect(ld.aggregateRating).toBeUndefined();
    expect(ld.review).toBeUndefined();
    const offer = ld.offers as Record<string, unknown>;
    expect(offer.hasMerchantReturnPolicy).toBeUndefined();
    expect(offer.openingHoursSpecification).toBeUndefined();
  });

  it("prefers the Google taxonomy path over a raw category for category", () => {
    const withTaxonomy = buildProductJsonLd(
      makeProduct({
        taxonomy: {
          google: "Food, Beverages & Tobacco > Food Items > Dairy Products",
        },
      })
    );
    expect(withTaxonomy.category).toBe(
      "Food, Beverages & Tobacco > Food Items > Dairy Products"
    );

    const withoutTaxonomy = buildProductJsonLd(
      makeProduct({ categories: ["cheese"] })
    );
    expect(withoutTaxonomy.category).toBe("cheese");
  });

  it("falls back to safe defaults for empty title/seller/images", () => {
    const ld = buildProductJsonLd(
      makeProduct({
        title: "",
        images: [],
        seller: { pubkey: "00".repeat(32), npub: "npub1x" },
        categories: [],
        taxonomy: undefined,
      })
    );
    expect(ld.name).toBe("Milk Market Listing");
    expect(ld.image).toBeUndefined();
    expect(ld.brand).toEqual({ "@type": "Brand", name: "Milk Market" });
    expect((ld.offers as Record<string, unknown>).seller).toEqual({
      "@type": "Organization",
      name: "Milk Market seller",
    });
    expect(ld.category).toBeUndefined();
  });
});

describe("moneyToPriceString", () => {
  it("formats fiat with the currency's decimal places", () => {
    expect(moneyToPriceString(usd(1200))).toBe("12.00");
    expect(moneyToPriceString(usd(599))).toBe("5.99");
  });

  it("formats zero-decimal currencies as whole numbers", () => {
    expect(
      moneyToPriceString({
        currency: "JPY",
        amount: 1000,
        exponent: 0,
        display: "1000",
      })
    ).toBe("1000");
  });

  it("formats bitcoin (exponent 8) as a decimal sat-to-btc value", () => {
    expect(moneyToPriceString(sats(150000000))).toBe("1.50000000");
  });
});

describe("buildItemListJsonLd", () => {
  it("builds an ordered ItemList of product links", () => {
    const products = [
      makeProduct({ url: "https://milk.market/listing/a", title: "A" }),
      makeProduct({ url: "https://milk.market/listing/b", title: "B" }),
    ];
    const ld = buildItemListJsonLd(products, {
      url: "https://milk.market/stall/farm",
      name: "Farm Stall",
    });

    expect(ld["@context"]).toBe("https://schema.org");
    expect(ld["@type"]).toBe("ItemList");
    expect(ld.url).toBe("https://milk.market/stall/farm");
    expect(ld.name).toBe("Farm Stall");
    expect(ld.numberOfItems).toBe(2);
    expect(ld.itemListElement).toEqual([
      {
        "@type": "ListItem",
        position: 1,
        url: "https://milk.market/listing/a",
        name: "A",
      },
      {
        "@type": "ListItem",
        position: 2,
        url: "https://milk.market/listing/b",
        name: "B",
      },
    ]);
  });

  it("omits name when not provided and handles an empty catalog", () => {
    const ld = buildItemListJsonLd([], {
      url: "https://milk.market/stall/empty",
    });
    expect(ld.name).toBeUndefined();
    expect(ld.numberOfItems).toBe(0);
    expect(ld.itemListElement).toEqual([]);
  });
});
