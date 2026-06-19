/** @jest-environment node */

// Unit coverage for the shared catalog mapper (utils/ucp/catalog.ts). This maps
// a NIP-99 (kind:30402) product event into the canonical UCP product shape used
// by BOTH the MCP catalog resource and the REST catalog endpoints, so a bug here
// would mis-describe products to every agentic client at once.

import {
  eventToUcpProduct,
  buildUcpCatalog,
  type InventorySnapshot,
} from "@/utils/ucp/catalog";
import { UCP_BITCOIN_CURRENCY } from "@/utils/ucp/money";
import { UCP_VENDOR_NAMESPACE } from "@/utils/ucp/types";
import type { NostrEvent } from "@/utils/types/types";

const SELLER_PUBKEY =
  "0000000000000000000000000000000000000000000000000000000000000001";

function makeEvent(
  tags: string[][],
  overrides: Partial<NostrEvent> = {}
): NostrEvent {
  return {
    id: "evt-1",
    pubkey: SELLER_PUBKEY,
    created_at: 1_700_000_000,
    kind: 30402,
    content: "fallback content",
    sig: "sig",
    tags,
    ...overrides,
  } as NostrEvent;
}

describe("eventToUcpProduct", () => {
  it("maps core fields, price (minor units), and absolute URLs", () => {
    const event = makeEvent([
      ["d", "raw-milk-gallon"],
      ["title", "Raw Milk"],
      ["summary", "Fresh from the farm"],
      ["price", "12", "USD"],
      ["t", "milk"],
      ["location", "Vermont"],
      ["image", "/photos/milk.jpg"],
      ["shipping", "Added Cost", "5", "USD"],
    ]);

    const p = eventToUcpProduct(event, { platformUrl: "https://milk.market" });

    expect(p.id).toBe("evt-1");
    expect(p.type).toBe("product");
    expect(p.title).toBe("Raw Milk");
    expect(p.description).toBe("Fresh from the farm");
    expect(p.price).toEqual({
      currency: "USD",
      amount: 1200,
      exponent: 2,
      display: "12.00",
    });
    expect(p.categories).toEqual(["milk"]);
    expect(p.location).toBe("Vermont");
    // Relative images become absolute against the platform URL.
    expect(p.images).toEqual(["https://milk.market/photos/milk.jpg"]);
    // Default canonical URL uses the d-tag slug on the platform host.
    expect(p.url).toBe("https://milk.market/listing/raw-milk-gallon");
    expect(p.shipping.cost).toEqual({
      currency: "USD",
      amount: 500,
      exponent: 2,
      display: "5.00",
    });
    expect(p.taxonomy?.google).toContain("Milk");
    expect(p.updatedAt).toBe(new Date(1_700_000_000 * 1000).toISOString());
    // Vendor extension carries the native (un-converted) price + event id.
    const ext = p.ext[UCP_VENDOR_NAMESPACE] as Record<string, unknown>;
    expect(ext.eventId).toBe("evt-1");
    expect(ext.nativePrice).toBe(12);
    expect(ext.nativeCurrency).toBe("USD");
  });

  it("derives a single-country shipping destination from the shipping currency", () => {
    const event = makeEvent([
      ["title", "Raw Milk"],
      ["price", "12", "USD"],
      ["shipping", "Added Cost", "5", "USD"],
    ]);
    const p = eventToUcpProduct(event);
    expect(p.shipping.destinationCountries).toEqual(["US"]);
  });

  it("omits the shipping destination for a multi-country currency (no fabrication)", () => {
    const event = makeEvent([
      ["title", "Raw Milk"],
      ["price", "12", "EUR"],
      ["shipping", "Added Cost", "5", "EUR"],
    ]);
    const p = eventToUcpProduct(event);
    expect(p.shipping.destinationCountries).toBeUndefined();
  });

  it("derives the destination from currency even for free/pickup ($0) rates", () => {
    const event = makeEvent([
      ["title", "Raw Milk"],
      ["price", "12", "USD"],
      ["shipping", "Pickup", "0", "USD"],
      ["pickup_location", "Farm gate"],
    ]);
    const p = eventToUcpProduct(event);
    // Pickup resolves to a $0 effective cost, so a US destination is truthful.
    expect(p.shipping.destinationCountries).toEqual(["US"]);
  });

  it("omits the shipping destination for bitcoin-priced shipping", () => {
    const event = makeEvent([
      ["title", "Sats Milk"],
      ["price", "2100"],
    ]);
    const p = eventToUcpProduct(event);
    expect(p.shipping.destinationCountries).toBeUndefined();
  });

  it("omits the shipping destination when there is no shipping tag (no fabrication from price currency)", () => {
    // A fiat product price must NOT leak into a fabricated destination: with no
    // valid shipping tag we have no real shipping config to derive a region from.
    const event = makeEvent([
      ["title", "Raw Milk"],
      ["price", "12", "USD"],
    ]);
    const p = eventToUcpProduct(event);
    expect(p.shipping.destinationCountries).toBeUndefined();
  });

  it("omits the shipping destination for an N/A shipping tag (no real shipping config)", () => {
    // "N/A" is a valid shipping type but means "no shipping config"; even with a
    // fiat currency on the tag it must not produce a fabricated destination.
    const event = makeEvent([
      ["title", "Raw Milk"],
      ["price", "12", "USD"],
      ["shipping", "N/A", "0", "USD"],
    ]);
    const p = eventToUcpProduct(event);
    expect(p.shipping.destinationCountries).toBeUndefined();
  });

  it("defaults a blank currency price to sats/XBT", () => {
    const event = makeEvent([
      ["title", "Sats Priced"],
      ["price", "2100"],
    ]);
    const p = eventToUcpProduct(event);
    expect(p.price.currency).toBe(UCP_BITCOIN_CURRENCY);
    expect(p.price.amount).toBe(2100);
    expect(p.price.exponent).toBe(8);
  });

  it("uses a placeholder image when none is provided", () => {
    const p = eventToUcpProduct(makeEvent([["title", "No Image"]]), {
      platformUrl: "https://milk.market",
    });
    expect(p.images).toEqual(["https://milk.market/milk-market.png"]);
  });

  it("keeps absolute image URLs untouched", () => {
    const p = eventToUcpProduct(
      makeEvent([
        ["title", "Hosted"],
        ["image", "https://cdn.example.com/a.jpg"],
      ])
    );
    expect(p.images).toEqual(["https://cdn.example.com/a.jpg"]);
  });

  it("uses the seller origin for product links when scoped to a domain", () => {
    const event = makeEvent([
      ["d", "raw-milk"],
      ["title", "Raw Milk"],
      ["price", "10", "USD"],
    ]);
    const p = eventToUcpProduct(event, {
      platformUrl: "https://milk.market",
      sellerOrigin: "https://farmer.com",
    });
    expect(p.url).toBe("https://farmer.com/listing/raw-milk");
  });

  it("uses the exact canonicalUrl override verbatim, beating slug/origin", () => {
    const event = makeEvent([
      // d-tag differs from the friendly title slug, so the default URL would
      // point at /listing/raw-milk-gallon-2024 (the raw identifier) instead of
      // the canonical /listing/raw-milk the page actually settles on.
      ["d", "raw-milk-gallon-2024"],
      ["title", "Raw Milk"],
      ["price", "10", "USD"],
    ]);
    const p = eventToUcpProduct(event, {
      platformUrl: "https://milk.market",
      sellerOrigin: "https://farmer.com",
      listingSlug: "raw-milk-gallon-2024",
      canonicalUrl: "https://farmer.com/listing/raw-milk",
    });
    expect(p.url).toBe("https://farmer.com/listing/raw-milk");
  });

  describe("availability", () => {
    it("treats a live inventory snapshot as authoritative (out of stock)", () => {
      const inventory: InventorySnapshot = {
        default_quantity: 0,
        variants: {},
      };
      const p = eventToUcpProduct(
        makeEvent([
          ["title", "Sold Out"],
          ["price", "10", "USD"],
        ]),
        { inventory }
      );
      expect(p.availability).toBe("out_of_stock");
      expect(p.inventory).toEqual({ tracked: true, quantity: 0 });
    });

    it("falls back to status='sold' when no inventory is tracked", () => {
      const p = eventToUcpProduct(
        makeEvent([
          ["title", "Sold"],
          ["price", "10", "USD"],
          ["status", "sold"],
        ])
      );
      expect(p.availability).toBe("out_of_stock");
    });

    it("defaults untracked listings to in_stock", () => {
      const p = eventToUcpProduct(
        makeEvent([
          ["title", "Available"],
          ["price", "10", "USD"],
        ])
      );
      expect(p.availability).toBe("in_stock");
      expect(p.inventory).toEqual({ tracked: false, quantity: null });
    });
  });

  describe("variants", () => {
    it("emits size variants sharing the base price with per-variant stock", () => {
      const inventory: InventorySnapshot = {
        default_quantity: null,
        variants: { "size:Gallon": 3, "size:Quart": 0 },
      };
      const p = eventToUcpProduct(
        makeEvent([
          ["title", "Milk"],
          ["price", "12", "USD"],
          ["size", "Gallon"],
          ["size", "Quart"],
        ]),
        { inventory }
      );
      const gallon = p.variants?.find((v) => v.id === "size:Gallon");
      const quart = p.variants?.find((v) => v.id === "size:Quart");
      expect(gallon?.price.amount).toBe(1200);
      expect(gallon?.available).toBe(true);
      expect(quart?.available).toBe(false);
    });

    it("emits volume variants with their own price tier", () => {
      const p = eventToUcpProduct(
        makeEvent([
          ["title", "Milk"],
          ["price", "12", "USD"],
          ["volume", "1 qt", "6"],
        ])
      );
      const vol = p.variants?.find((v) => v.id === "volume:1 qt");
      expect(vol?.price.amount).toBe(600);
    });

    it("emits descriptive-only variants at the base price", () => {
      const p = eventToUcpProduct(
        makeEvent([
          ["title", "Milk"],
          ["price", "12", "USD"],
          ["variant", "Glass Bottle"],
        ])
      );
      const v = p.variants?.find((x) => x.id === "variant:Glass Bottle");
      expect(v?.price.amount).toBe(1200);
    });
  });

  it("includes subscription metadata when enabled", () => {
    const p = eventToUcpProduct(
      makeEvent([
        ["title", "Milk"],
        ["price", "12", "USD"],
        ["subscription", "true"],
        ["subscription_discount", "10"],
        ["subscription_frequency", "weekly", "monthly"],
      ])
    );
    expect(p.subscription).toEqual({
      enabled: true,
      discountPercent: 10,
      frequencies: ["weekly", "monthly"],
    });
  });

  it("defaults payment methods to bitcoin-native and accepts an override", () => {
    const base = eventToUcpProduct(
      makeEvent([
        ["title", "Milk"],
        ["price", "12", "USD"],
      ])
    );
    expect(base.paymentMethods).toEqual(["lightning", "cashu"]);

    const withStripe = eventToUcpProduct(
      makeEvent([
        ["title", "Milk"],
        ["price", "12", "USD"],
      ]),
      { paymentMethods: ["lightning", "cashu", "stripe"] }
    );
    expect(withStripe.paymentMethods).toContain("stripe");
  });
});

describe("buildUcpCatalog", () => {
  it("maps every event and disambiguates slugs per seller", () => {
    const events: NostrEvent[] = [
      makeEvent(
        [
          ["d", "a"],
          ["title", "Raw Milk"],
          ["price", "10", "USD"],
        ],
        { id: "evt-a" }
      ),
      makeEvent(
        [
          ["d", "b"],
          ["title", "Cheese"],
          ["price", "20", "USD"],
        ],
        { id: "evt-b" }
      ),
    ];
    const catalog = buildUcpCatalog(events, {
      platformUrl: "https://milk.market",
    });
    expect(catalog).toHaveLength(2);
    expect(catalog.map((p) => p.id).sort()).toEqual(["evt-a", "evt-b"]);
    for (const p of catalog) {
      expect(p.url.startsWith("https://milk.market/listing/")).toBe(true);
    }
  });

  it("applies seller names from the provided map", () => {
    const events = [
      makeEvent([
        ["title", "Milk"],
        ["price", "10", "USD"],
      ]),
    ];
    const catalog = buildUcpCatalog(events, {
      sellerNames: new Map([[SELLER_PUBKEY, "Happy Farm"]]),
    });
    expect(catalog[0]!.seller.name).toBe("Happy Farm");
  });
});
