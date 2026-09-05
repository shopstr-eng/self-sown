// Kind-30406 shipping option fetch/resolution: per-author filter grouping,
// latest-per-address dedup (options are mutable), failure tolerance, and
// product-ref resolution order.

import {
  eligibleShippingOptions,
  fetchShippingOptionsByAddresses,
  fetchShippingOptionsForSeller,
  isSpecDestinationBlocked,
  resolveProductShippingOptions,
  resolvedOptionCost,
  toCountryCode,
} from "@/utils/nostr/fetch-shipping-options";
import { buildShippingOptionEventTemplate } from "@/utils/parsers/shipping-option-parser";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);

function optionEvent(
  pubkey: string,
  d: string,
  createdAt: number,
  baseCost = 5
) {
  const template = buildShippingOptionEventTemplate({
    d,
    title: `Option ${d}`,
    baseCost,
    currency: "USD",
    countries: ["US"],
    service: "standard",
  });
  return {
    id: `${pubkey}-${d}-${createdAt}`,
    pubkey,
    kind: 30406,
    created_at: createdAt,
    content: template.content,
    tags: template.tags,
  } as any;
}

const mockNostr = (events: any[] = [], shouldThrow = false) =>
  ({
    fetch: jest.fn(async () => {
      if (shouldThrow) throw new Error("relay down");
      return events;
    }),
  }) as any;

describe("fetchShippingOptionsByAddresses", () => {
  it("groups refs into one filter per author with #d narrowing", async () => {
    const nostr = mockNostr([]);
    await fetchShippingOptionsByAddresses(
      nostr,
      ["wss://relay"],
      [`30406:${ALICE}:std`, `30406:${ALICE}:express`, `30406:${BOB}:std`]
    );
    expect(nostr.fetch).toHaveBeenCalledTimes(1);
    const [filters] = nostr.fetch.mock.calls[0];
    expect(filters).toHaveLength(2);
    expect(filters).toContainEqual({
      kinds: [30406],
      authors: [ALICE],
      "#d": ["std", "express"],
    });
    expect(filters).toContainEqual({
      kinds: [30406],
      authors: [BOB],
      "#d": ["std"],
    });
  });

  it("dedups to the latest event per address and parses options", async () => {
    const nostr = mockNostr([
      optionEvent(ALICE, "std", 100, 5),
      optionEvent(ALICE, "std", 200, 7), // newer wins
    ]);
    const map = await fetchShippingOptionsByAddresses(
      nostr,
      ["wss://relay"],
      [`30406:${ALICE}:std`]
    );
    expect(map.size).toBe(1);
    const option = map.get(`30406:${ALICE}:std`)!;
    expect(option.baseCost).toBe(7);
    expect(option.address).toBe(`30406:${ALICE}:std`);
  });

  it("skips collection (30405) refs and malformed refs without fetching", async () => {
    const nostr = mockNostr([]);
    const map = await fetchShippingOptionsByAddresses(
      nostr,
      ["wss://relay"],
      [`30405:${ALICE}:stall`, "garbage"]
    );
    expect(nostr.fetch).not.toHaveBeenCalled();
    expect(map.size).toBe(0);
  });

  it("never rejects on relay failure — returns what it has", async () => {
    const nostr = mockNostr([], true);
    const map = await fetchShippingOptionsByAddresses(
      nostr,
      ["wss://relay"],
      [`30406:${ALICE}:std`]
    );
    expect(map.size).toBe(0);
  });

  it("drops events that fail required-tag validation", async () => {
    const invalid = {
      id: "x",
      pubkey: ALICE,
      kind: 30406,
      created_at: 100,
      content: "",
      tags: [["d", "broken"]], // missing title/price/country/service
    } as any;
    const nostr = mockNostr([invalid]);
    const map = await fetchShippingOptionsByAddresses(
      nostr,
      ["wss://relay"],
      [`30406:${ALICE}:broken`]
    );
    expect(map.size).toBe(0);
  });
});

describe("fetchShippingOptionsForSeller", () => {
  it("fetches all of a seller's options with an author filter", async () => {
    const nostr = mockNostr([optionEvent(ALICE, "a", 100)]);
    const map = await fetchShippingOptionsForSeller(
      nostr,
      ["wss://relay"],
      ALICE
    );
    expect(nostr.fetch).toHaveBeenCalledWith(
      [{ kinds: [30406], authors: [ALICE] }],
      {},
      ["wss://relay"]
    );
    expect(map.size).toBe(1);
  });
});

describe("resolveProductShippingOptions", () => {
  it("resolves refs in product order with extra costs, skipping unknown and collection refs", async () => {
    const nostr = mockNostr([
      optionEvent(ALICE, "std", 100, 5),
      optionEvent(ALICE, "express", 100, 12),
    ]);
    const options = await fetchShippingOptionsByAddresses(
      nostr,
      ["wss://relay"],
      [`30406:${ALICE}:std`, `30406:${ALICE}:express`]
    );
    const product = {
      id: "p1",
      shippingOptions: [
        { reference: `30406:${ALICE}:express` },
        { reference: `30406:${ALICE}:std`, extraCost: 1.5 },
        { reference: `30406:${ALICE}:missing` },
        { reference: `30405:${ALICE}:stall` },
      ],
    } as any;
    const resolved = resolveProductShippingOptions(product, options);
    expect(resolved.map((r) => r.option.d)).toEqual(["express", "std"]);
    expect(resolved[1]!.extraCost).toBe(1.5);
    expect(resolvedOptionCost(resolved[1]!)).toBe(6.5);
    expect(resolvedOptionCost(resolved[0]!)).toBe(12);
  });

  it("returns an empty list when the product has no refs", () => {
    expect(
      resolveProductShippingOptions({ id: "p" } as any, new Map())
    ).toEqual([]);
  });
});

describe("toCountryCode / eligibleShippingOptions", () => {
  const opt = (countries: string[]) => ({ option: { countries } }) as any;

  it("maps buyer-form country names to ISO codes", () => {
    // locationSelection.json (the address form's source) uses "United States
    // of America"; common variants are aliased.
    expect(toCountryCode("United States of America")).toBe("US");
    expect(toCountryCode("United States")).toBe("US");
    expect(toCountryCode("USA")).toBe("US");
    expect(toCountryCode("us")).toBe("US");
    expect(toCountryCode("Atlantis")).toBe("");
    expect(toCountryCode("")).toBe("");
    expect(toCountryCode("  Germany ")).toBe("DE");
  });

  it("keeps every option when the buyer country is unknown or unmappable", () => {
    const options = [opt(["US"]), opt(["DE"])];
    expect(eligibleShippingOptions(options, undefined)).toHaveLength(2);
    expect(eligibleShippingOptions(options, "Atlantis")).toHaveLength(2);
  });

  it("filters options to the buyer's destination country", () => {
    const options = [opt(["US", "CA"]), opt(["DE"])];
    expect(
      eligibleShippingOptions(options, "United States of America")
    ).toHaveLength(1);
    expect(eligibleShippingOptions(options, "Germany")).toHaveLength(1);
    expect(eligibleShippingOptions(options, "France")).toHaveLength(0);
  });
});

describe("isSpecDestinationBlocked", () => {
  it("blocks only when options exist, none is eligible, and the country is mappable", () => {
    // Excluded destination: options exist, none serves Canada, country known.
    expect(isSpecDestinationBlocked(2, "Canada", 0)).toBe(true);
    // No spec options on the product -> legacy path, never blocked.
    expect(isSpecDestinationBlocked(0, "Canada", 0)).toBe(false);
    // At least one eligible option -> not blocked.
    expect(isSpecDestinationBlocked(2, "Canada", 1)).toBe(false);
    // Country not entered yet -> cannot evaluate, not blocked.
    expect(isSpecDestinationBlocked(2, "", 0)).toBe(false);
    expect(isSpecDestinationBlocked(2, undefined, 0)).toBe(false);
    // Unmappable country -> cannot evaluate, not blocked.
    expect(isSpecDestinationBlocked(2, "Atlantis", 0)).toBe(false);
  });
});
