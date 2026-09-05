// Kind-30406 shipping option events (marketplace spec): strict required-tag
// validation with per-tag tolerance for optional fields, product-side
// shipping_option reference tags, and builder round-trips.

import {
  SHIPPING_OPTION_KIND,
  isShippingOptionReference,
  parseShippingOptionEvent,
  buildShippingOptionEventTemplate,
  ShippingOptionDraft,
} from "@/utils/parsers/shipping-option-parser";
import {
  parseShippingOptionRefTag,
  buildShippingOptionRefTag,
} from "@/utils/parsers/product-tag-helpers";
import { parseTags } from "@/utils/parsers/product-parser-functions";

const PUBKEY = "a".repeat(64);

function makeEvent(tags: string[][], content = "") {
  return {
    id: "event-id",
    pubkey: PUBKEY,
    kind: SHIPPING_OPTION_KIND,
    created_at: 1703187600,
    content,
    tags,
  } as any;
}

const VALID_TAGS: string[][] = [
  ["d", "standard-regional"],
  ["title", "Standard Shipping"],
  ["price", "5.99", "USD"],
  ["country", "US"],
  ["service", "standard"],
];

describe("parseShippingOptionEvent", () => {
  it("parses the spec's full standard-shipping example", () => {
    const event = makeEvent([
      ...VALID_TAGS,
      ["carrier", "UPS"],
      ["region", "US-FL", "US-GA"],
      ["duration", "24", "72", "H"],
      ["location", "123 Main St"],
      ["g", "dhwm9c4ws"],
      ["weight-min", "0.1", "kg"],
      ["weight-max", "30", "kg"],
      ["dim-max", "120x60x60", "cm"],
      ["price-weight", "0.75", "USD"],
      ["price-volume", "1.25", "USD"],
      ["price-distance", "2.50", "USD"],
    ]);
    const option = parseShippingOptionEvent(event);
    expect(option).not.toBeNull();
    expect(option!.d).toBe("standard-regional");
    expect(option!.title).toBe("Standard Shipping");
    expect(option!.baseCost).toBe(5.99);
    expect(option!.currency).toBe("USD");
    expect(option!.countries).toEqual(["US"]);
    expect(option!.service).toBe("standard");
    expect(option!.carrier).toBe("UPS");
    expect(option!.regions).toEqual(["US-FL", "US-GA"]);
    expect(option!.duration).toEqual({ min: 24, max: 72, unit: "H" });
    expect(option!.location).toBe("123 Main St");
    expect(option!.geohash).toBe("dhwm9c4ws");
    expect(option!.weightMin).toEqual({ value: 0.1, unit: "kg" });
    expect(option!.weightMax).toEqual({ value: 30, unit: "kg" });
    expect(option!.dimMax).toEqual({ dims: "120x60x60", unit: "cm" });
    expect(option!.pricePerWeight).toEqual({ price: 0.75, unit: "USD" });
    expect(option!.pricePerVolume).toEqual({ price: 1.25, unit: "USD" });
    expect(option!.pricePerDistance).toEqual({ price: 2.5, unit: "USD" });
    expect(option!.address).toBe(`30406:${PUBKEY}:standard-regional`);
  });

  it("parses the spec's local-pickup example", () => {
    const option = parseShippingOptionEvent(
      makeEvent(
        [
          ["d", "downtown-pickup"],
          ["title", "Downtown Store Pickup"],
          ["price", "0", "USD"],
          ["country", "US"],
          ["region", "US-FL"],
          ["service", "pickup"],
          ["location", "123 Main St, Downtown, FL"],
          ["g", "dhwm9c4ws"],
        ],
        "Downtown Store Pickup"
      )
    );
    expect(option).not.toBeNull();
    expect(option!.service).toBe("pickup");
    expect(option!.baseCost).toBe(0);
    expect(option!.description).toBe("Downtown Store Pickup");
  });

  it("accepts multiple country codes in one tag and across tags, deduped and uppercased", () => {
    const option = parseShippingOptionEvent(
      makeEvent([
        ["d", "multi"],
        ["title", "Multi"],
        ["price", "1", "EUR"],
        ["country", "us", "CA"],
        ["country", "US", "gb"],
        ["service", "express"],
      ])
    );
    expect(option!.countries).toEqual(["US", "CA", "GB"]);
  });

  it.each([
    ["d", VALID_TAGS.filter((t) => t[0] !== "d")],
    ["title", VALID_TAGS.filter((t) => t[0] !== "title")],
    ["price", VALID_TAGS.filter((t) => t[0] !== "price")],
    ["country", VALID_TAGS.filter((t) => t[0] !== "country")],
    ["service", VALID_TAGS.filter((t) => t[0] !== "service")],
  ])("rejects the event when required tag %s is missing", (_name, tags) => {
    expect(parseShippingOptionEvent(makeEvent(tags))).toBeNull();
  });

  it("rejects the event on an invalid price, service, or country", () => {
    const withPrice = VALID_TAGS.map((t) =>
      t[0] === "price" ? ["price", "-5", "USD"] : t
    );
    expect(parseShippingOptionEvent(makeEvent(withPrice))).toBeNull();

    const withService = VALID_TAGS.map((t) =>
      t[0] === "service" ? ["service", "teleport"] : t
    );
    expect(parseShippingOptionEvent(makeEvent(withService))).toBeNull();

    const withCountry = VALID_TAGS.map((t) =>
      t[0] === "country" ? ["country", "XX"] : t
    );
    expect(parseShippingOptionEvent(makeEvent(withCountry))).toBeNull();
  });

  it("rejects events of the wrong kind", () => {
    expect(
      parseShippingOptionEvent({ ...makeEvent(VALID_TAGS), kind: 30402 })
    ).toBeNull();
  });

  it("drops malformed optional tags without rejecting the event", () => {
    const option = parseShippingOptionEvent(
      makeEvent([
        ...VALID_TAGS,
        ["duration", "24", "72", "parsecs"], // bad unit
        ["weight-max", "heavy", "kg"], // non-numeric
        ["dim-max", "12x60", "cm"], // only 2 dims
        ["price-weight", "0.75"], // missing unit
        ["region", "not-a-region"],
      ])
    );
    expect(option).not.toBeNull();
    expect(option!.duration).toBeUndefined();
    expect(option!.weightMax).toBeUndefined();
    expect(option!.dimMax).toBeUndefined();
    expect(option!.pricePerWeight).toBeUndefined();
    expect(option!.regions).toBeUndefined();
  });
});

describe("shipping_option reference tags", () => {
  it("validates addressable references", () => {
    expect(isShippingOptionReference(`30406:${PUBKEY}:std`)).toBe(true);
    expect(isShippingOptionReference(`30405:${PUBKEY}:stall`)).toBe(true);
    expect(isShippingOptionReference(`30406:${PUBKEY.slice(1)}:std`)).toBe(
      false
    );
    expect(isShippingOptionReference("30406:not-a-pubkey:std")).toBe(false);
    expect(isShippingOptionReference(`30402:${PUBKEY}:product`)).toBe(false);
  });

  it("parses direct refs with and without extra cost", () => {
    expect(
      parseShippingOptionRefTag(["shipping_option", `30406:${PUBKEY}:std`])
    ).toEqual({ reference: `30406:${PUBKEY}:std` });
    expect(
      parseShippingOptionRefTag([
        "shipping_option",
        `30406:${PUBKEY}:std`,
        "2.50",
      ])
    ).toEqual({ reference: `30406:${PUBKEY}:std`, extraCost: 2.5 });
  });

  it("accepts collection refs (30405) for later resolution", () => {
    expect(
      parseShippingOptionRefTag(["shipping_option", `30405:${PUBKEY}:stall`])
    ).toEqual({ reference: `30405:${PUBKEY}:stall` });
  });

  it("rejects malformed refs and negative extra costs", () => {
    expect(
      parseShippingOptionRefTag(["shipping_option", "junk"])
    ).toBeUndefined();
    expect(
      parseShippingOptionRefTag([
        "shipping_option",
        `30406:${PUBKEY}:std`,
        "-1",
      ])
    ).toBeUndefined();
    expect(
      parseShippingOptionRefTag([
        "shipping_option",
        `30406:${PUBKEY}:std`,
        "abc",
      ])
    ).toBeUndefined();
    expect(parseShippingOptionRefTag(["shipping_option"])).toBeUndefined();
  });

  it("builds ref tags and refuses invalid input", () => {
    expect(buildShippingOptionRefTag(`30406:${PUBKEY}:std`)).toEqual([
      "shipping_option",
      `30406:${PUBKEY}:std`,
    ]);
    expect(buildShippingOptionRefTag(`30406:${PUBKEY}:std`, 2.5)).toEqual([
      "shipping_option",
      `30406:${PUBKEY}:std`,
      "2.5",
    ]);
    // Blank extra cost = no surcharge (never Number("")==0 into a real 0 tag)
    expect(buildShippingOptionRefTag(`30406:${PUBKEY}:std`, "")).toEqual([
      "shipping_option",
      `30406:${PUBKEY}:std`,
    ]);
    expect(buildShippingOptionRefTag("junk")).toBeUndefined();
    expect(
      buildShippingOptionRefTag(`30406:${PUBKEY}:std`, -1)
    ).toBeUndefined();
  });
});

describe("product parser integration", () => {
  it("collects shipping_option refs onto ProductData, deduped, preserving order", () => {
    const product = parseTags({
      id: "p1",
      pubkey: PUBKEY,
      kind: 30402,
      created_at: 1703187600,
      content: "",
      tags: [
        ["d", "prod"],
        ["title", "Product"],
        ["price", "10", "USD"],
        ["shipping_option", `30406:${PUBKEY}:std`, "1.50"],
        ["shipping_option", `30406:${PUBKEY}:express`],
        ["shipping_option", `30406:${PUBKEY}:std`, "9.99"], // dup ref ignored
        ["shipping_option", "garbage"], // malformed ignored
      ],
    } as any);
    expect(product!.shippingOptions).toEqual([
      { reference: `30406:${PUBKEY}:std`, extraCost: 1.5 },
      { reference: `30406:${PUBKEY}:express` },
    ]);
  });

  it("leaves shippingOptions undefined when no refs exist", () => {
    const product = parseTags({
      id: "p1",
      pubkey: PUBKEY,
      kind: 30402,
      created_at: 1703187600,
      content: "",
      tags: [
        ["d", "prod"],
        ["title", "Product"],
        ["price", "10", "USD"],
      ],
    } as any);
    expect(product!.shippingOptions).toBeUndefined();
  });
});

describe("buildShippingOptionEventTemplate", () => {
  it("round-trips a full draft through the parser", () => {
    const draft: ShippingOptionDraft = {
      d: "express-us",
      title: "Express US",
      baseCost: 12.99,
      currency: "USD",
      countries: ["us"],
      service: "express",
      description: "Fast shipping",
      carrier: "FedEx",
      regions: ["us-ca"],
      duration: { min: 1, max: 2, unit: "D" },
      weightMax: { value: 10, unit: "kg" },
      dimMax: { dims: "60x40x40", unit: "cm" },
      pricePerWeight: { price: 1.5, unit: "USD" },
    };
    const template = buildShippingOptionEventTemplate(draft);
    expect(template.kind).toBe(30406);
    expect(template.content).toBe("Fast shipping");

    const parsed = parseShippingOptionEvent(
      makeEvent(template.tags, template.content)
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.d).toBe("express-us");
    expect(parsed!.baseCost).toBe(12.99);
    expect(parsed!.countries).toEqual(["US"]);
    expect(parsed!.service).toBe("express");
    expect(parsed!.carrier).toBe("FedEx");
    expect(parsed!.regions).toEqual(["US-CA"]);
    expect(parsed!.duration).toEqual({ min: 1, max: 2, unit: "D" });
    expect(parsed!.weightMax).toEqual({ value: 10, unit: "kg" });
    expect(parsed!.dimMax).toEqual({ dims: "60x40x40", unit: "cm" });
    expect(parsed!.pricePerWeight).toEqual({ price: 1.5, unit: "USD" });
  });

  it("drops invalid optional values instead of writing corrupt tags", () => {
    const template = buildShippingOptionEventTemplate({
      d: "std",
      title: "Standard",
      baseCost: 5,
      currency: "USD",
      countries: ["US"],
      service: "standard",
      weightMax: { value: -1, unit: "kg" },
      dimMax: { dims: "not-dims", unit: "cm" },
    });
    const names = template.tags.map((t) => t[0]);
    expect(names).not.toContain("weight-max");
    expect(names).not.toContain("dim-max");
  });
});
