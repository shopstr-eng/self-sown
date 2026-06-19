/** @jest-environment node */

// Unit coverage for the UCP/GEO product taxonomy mapper (utils/ucp/taxonomy.ts).
// Shopping agents and search engines rely on standard Google/Shopify taxonomy
// codes; this maps Milk Market's free-form category tags onto them and lets
// sellers override per product.

import { taxonomyFromCategories, resolveTaxonomy } from "@/utils/ucp/taxonomy";

describe("taxonomyFromCategories", () => {
  it("maps a known category to Google + Shopify paths", () => {
    const t = taxonomyFromCategories(["milk"]);
    expect(t.google).toContain("Dairy Products > Milk");
    expect(t.shopify).toContain("Dairy Products > Milk");
  });

  it("is case-insensitive and trims", () => {
    expect(taxonomyFromCategories([" Cheese "]).google).toContain("Cheese");
  });

  it("returns the first category with a known mapping", () => {
    // "unknownthing" has no mapping; "eggs" does — the first hit wins.
    const t = taxonomyFromCategories(["unknownthing", "eggs"]);
    expect(t.google).toContain("Eggs");
  });

  it("returns an empty object when nothing matches", () => {
    expect(taxonomyFromCategories(["nonsense"])).toEqual({});
    expect(taxonomyFromCategories([])).toEqual({});
  });
});

describe("resolveTaxonomy", () => {
  it("prefers explicit overrides over derived defaults", () => {
    const t = resolveTaxonomy({
      categories: ["milk"],
      googleOverride: "Custom > Google > Path",
      shopifyOverride: "Custom > Shopify > Path",
    });
    expect(t.google).toBe("Custom > Google > Path");
    expect(t.shopify).toBe("Custom > Shopify > Path");
  });

  it("ignores blank overrides and keeps the derived default", () => {
    const t = resolveTaxonomy({
      categories: ["milk"],
      googleOverride: "   ",
      shopifyOverride: "",
    });
    expect(t.google).toContain("Milk");
    expect(t.shopify).toContain("Milk");
  });

  it("returns an empty object when there is nothing to map", () => {
    expect(resolveTaxonomy({ categories: ["nonsense"] })).toEqual({});
  });
});
