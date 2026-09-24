/**
 * Shopify → NIP-99 migration discovery-tag coverage.
 *
 * Imported Shopify tags are seller-controlled, so the builder must normalize
 * the merged tag set: exactly one canonical ["t", "SelfSown"] discovery tag,
 * never a legacy "MilkMarket" spelling carried forward, and never duplicates.
 */
import { buildListingFromShopifyProduct } from "@/utils/migrations/shopify-to-nip99";
import type { ShopifyProduct } from "@/utils/migrations/shopify-csv-parser";

const options = {
  pubkey: "abc",
  relayHint: "wss://relay.example.com",
  defaultCurrency: "USD",
  defaultCategory: "Beef",
  defaultLocation: "Farm",
  defaultShippingOption: "N/A",
  defaultShippingCost: "0",
};

const baseProduct: ShopifyProduct = {
  handle: "creamline-milk",
  title: "Creamline Milk",
  description: "",
  vendor: "",
  productCategory: "",
  type: "",
  tags: [],
  status: "active",
  publishedOnOnlineStore: true,
  giftCard: false,
  seoTitle: "",
  seoDescription: "",
  googleProductCategory: "",
  googleCondition: "",
  imageUrls: ["https://example.com/milk.jpg"],
  variants: [
    {
      sku: "",
      barcode: "",
      optionNames: [],
      optionValues: [],
      price: "5.00",
      compareAtPrice: "",
      inventoryQuantity: 0,
      weight: "",
      weightUnit: "",
      requiresShipping: false,
      variantImageUrl: "",
    },
  ],
  rawRows: [],
};

const tTags = (values: string[][]) => values.filter((t) => t[0] === "t");

describe("buildListingFromShopifyProduct discovery tags", () => {
  it("emits exactly one SelfSown tag when imported tags contain MilkMarket/SelfSown", () => {
    const { values } = buildListingFromShopifyProduct(
      { ...baseProduct, tags: ["MilkMarket", "SelfSown", "Dairy"] },
      options
    );
    const t = tTags(values);
    expect(t.filter((tag) => tag[1] === "SelfSown")).toHaveLength(1);
    expect(t.some((tag) => tag[1] === "MilkMarket")).toBe(false);
    // Non-discovery imported tags are preserved.
    expect(t.some((tag) => tag[1] === "Dairy")).toBe(true);
    expect(t.some((tag) => tag[1] === "FREEMILK")).toBe(true);
  });

  it("still emits exactly one SelfSown with no imported tags", () => {
    const { values } = buildListingFromShopifyProduct(baseProduct, options);
    const t = tTags(values);
    expect(t.filter((tag) => tag[1] === "SelfSown")).toHaveLength(1);
    expect(t.some((tag) => tag[1] === "MilkMarket")).toBe(false);
  });

  it("strips a legacy MilkMarket spelling even when it is the default category", () => {
    const { values } = buildListingFromShopifyProduct(baseProduct, {
      ...options,
      defaultCategory: "MilkMarket",
    });
    const t = tTags(values);
    expect(t.filter((tag) => tag[1] === "SelfSown")).toHaveLength(1);
    expect(t.some((tag) => tag[1] === "MilkMarket")).toBe(false);
  });

  it("keeps imported type/vendor tags while normalizing discovery tags", () => {
    const { values } = buildListingFromShopifyProduct(
      { ...baseProduct, type: "MilkMarket", vendor: "SelfSown" },
      options
    );
    const t = tTags(values);
    expect(t.filter((tag) => tag[1] === "SelfSown")).toHaveLength(1);
    expect(t.some((tag) => tag[1] === "MilkMarket")).toBe(false);
  });
});
