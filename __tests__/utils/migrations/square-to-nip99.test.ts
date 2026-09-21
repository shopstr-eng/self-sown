/**
 * Square → NIP-99 migration discovery-tag coverage.
 *
 * The builder must emit exactly one canonical ["t", "SelfSown"] discovery
 * tag, never a legacy "MilkMarket" spelling (e.g. a seller-picked default
 * category), and never duplicates.
 */
import { buildListingFromSquareItem } from "@/utils/migrations/square-to-nip99";
import type { SquareCatalogItem } from "@/utils/migrations/square-to-nip99";

const options = {
  pubkey: "abc",
  relayHint: "wss://relay.example.com",
  defaultCurrency: "USD",
  defaultCategory: "Beef",
  defaultLocation: "Farm",
  defaultShippingOption: "N/A",
  defaultShippingCost: "0",
};

const baseItem: SquareCatalogItem = {
  id: "item-1",
  name: "Creamline Milk",
  description: null,
  imageUrls: ["https://example.com/milk.jpg"],
  variations: [
    {
      id: "var-1",
      name: null,
      priceAmount: 500,
      priceCurrency: "USD",
      sku: null,
    },
  ],
  isArchived: false,
};

const tTags = (values: string[][]) => values.filter((t) => t[0] === "t");

describe("buildListingFromSquareItem discovery tags", () => {
  it("emits exactly one SelfSown tag and no MilkMarket tag", () => {
    const { values } = buildListingFromSquareItem(baseItem, options);
    const t = tTags(values);
    expect(t.filter((tag) => tag[1] === "SelfSown")).toHaveLength(1);
    expect(t.some((tag) => tag[1] === "MilkMarket")).toBe(false);
    expect(t.some((tag) => tag[1] === "FREEMILK")).toBe(true);
    expect(t.some((tag) => tag[1] === "Beef")).toBe(true);
  });

  it("strips a legacy MilkMarket spelling when it is the default category", () => {
    const { values } = buildListingFromSquareItem(baseItem, {
      ...options,
      defaultCategory: "MilkMarket",
    });
    const t = tTags(values);
    expect(t.filter((tag) => tag[1] === "SelfSown")).toHaveLength(1);
    expect(t.some((tag) => tag[1] === "MilkMarket")).toBe(false);
  });

  it("collapses a default category of SelfSown to a single discovery tag", () => {
    const { values } = buildListingFromSquareItem(baseItem, {
      ...options,
      defaultCategory: "SelfSown",
    });
    const t = tTags(values);
    expect(t.filter((tag) => tag[1] === "SelfSown")).toHaveLength(1);
  });
});
