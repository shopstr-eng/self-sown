import {
  buildProductPageConfig,
  parseProductPageConfig,
  parseProductPageConfigJson,
  PRODUCT_PAGE_CONFIG_FIELDS,
  validateProductPageConfig,
  withProductPageConfig,
} from "../product-page-config";
import { normalizeMarketplaceDiscoveryTag } from "../listing";
import type { StorefrontSection } from "../storefront";

const baseSection: StorefrontSection = {
  id: "s1",
  type: "product_description",
  enabled: true,
  heading: "About this product",
};

describe("buildProductPageConfig", () => {
  it("collapses an all-empty input to null (tag gets removed)", () => {
    expect(
      buildProductPageConfig({
        sections: [],
        useShopDefaults: true,
        themeOverrides: {},
        metaTitle: "  ",
        metaDescription: "",
        ogImage: "",
      })
    ).toBeNull();
  });

  it("omits sections when using shop defaults, keeping them in state only", () => {
    expect(
      buildProductPageConfig({
        sections: [baseSection],
        useShopDefaults: true,
        themeOverrides: {},
        metaTitle: "",
        metaDescription: "",
        ogImage: "",
      })
    ).toBeNull();
  });

  it("keeps the sections array when defaults are off, even when empty", () => {
    expect(
      buildProductPageConfig({
        sections: [],
        useShopDefaults: false,
        themeOverrides: {},
        metaTitle: "",
        metaDescription: "",
        ogImage: "",
      })
    ).toEqual({ sections: [] });
  });

  it("trims strings and drops empty values", () => {
    expect(
      buildProductPageConfig({
        sections: [baseSection],
        useShopDefaults: false,
        themeOverrides: { primary: "#1A2B3C" },
        metaTitle: "  Fresh Milk  ",
        metaDescription: "",
        ogImage: " https://example.com/og.png ",
      })
    ).toEqual({
      sections: [baseSection],
      themeOverrides: { primary: "#1A2B3C" },
      metaTitle: "Fresh Milk",
      ogImage: "https://example.com/og.png",
    });
  });
});

describe("validateProductPageConfig", () => {
  it("passes null (no customization) and a valid config", () => {
    expect(validateProductPageConfig(null)).toBeNull();
    expect(
      validateProductPageConfig({
        sections: [baseSection],
        themeOverrides: { primary: "#FFF", text: "#00000000" },
        ogImage: "https://example.com/og.png",
        metaTitle: "Title",
        metaDescription: "Description",
      })
    ).toBeNull();
  });

  it("rejects a non-hex theme override", () => {
    expect(
      validateProductPageConfig({ themeOverrides: { primary: "blue" } })
    ).toContain('Color "primary" must be a valid hex value');
  });

  it("rejects an invalid og image URL", () => {
    expect(validateProductPageConfig({ ogImage: "not a url" })).toBe(
      "OG image must be a valid URL."
    );
  });

  it("enforces the meta title and description length caps", () => {
    expect(validateProductPageConfig({ metaTitle: "x".repeat(201) })).toContain(
      "Meta title is too long"
    );
    expect(
      validateProductPageConfig({ metaDescription: "x".repeat(501) })
    ).toContain("Meta description is too long");
  });

  it("rejects a specification with an empty label or value", () => {
    expect(
      validateProductPageConfig({
        sections: [
          {
            id: "s2",
            type: "product_specifications",
            specifications: [{ label: "  ", value: "A2" }],
          },
        ],
      })
    ).toContain("(Specifications) has an empty label or value");
  });

  it("rejects a gallery image that is not a URL", () => {
    expect(
      validateProductPageConfig({
        sections: [
          {
            id: "s3",
            type: "product_gallery",
            galleryImages: ["notaurl"],
          },
        ],
      })
    ).toContain("(Gallery) has an invalid image URL");
  });

  it("blocks configs over the serialized size cap", () => {
    expect(
      validateProductPageConfig({
        ogImage: "https://example.com/" + "x".repeat(70 * 1024),
      })
    ).toContain("Customization is too large");
  });
});

describe("parseProductPageConfig", () => {
  it("parses a page_config tag", () => {
    expect(
      parseProductPageConfig([
        ["d", "abc"],
        ["page_config", JSON.stringify({ metaTitle: "Hi" })],
      ])
    ).toEqual({ metaTitle: "Hi" });
  });

  it("last tag wins, mirroring the web parser's assignment loop", () => {
    expect(
      parseProductPageConfig([
        ["page_config", JSON.stringify({ metaTitle: "First" })],
        ["page_config", JSON.stringify({ metaTitle: "Last" })],
      ])
    ).toEqual({ metaTitle: "Last" });
  });

  it("returns undefined for missing, invalid, or non-object payloads", () => {
    expect(parseProductPageConfig([["d", "abc"]])).toBeUndefined();
    expect(parseProductPageConfig([["page_config", "{oops"]])).toBeUndefined();
    expect(parseProductPageConfig([["page_config", "[1]"]])).toBeUndefined();
    expect(parseProductPageConfigJson("42")).toBeUndefined();
  });
});

describe("withProductPageConfig", () => {
  it("appends the tag when a config is given", () => {
    expect(withProductPageConfig([["d", "abc"]], { metaTitle: "Hi" })).toEqual([
      ["d", "abc"],
      ["page_config", JSON.stringify({ metaTitle: "Hi" })],
    ]);
  });

  it("replaces an existing tag and removes it when config is null", () => {
    const tags = [
      ["d", "abc"],
      ["page_config", JSON.stringify({ metaTitle: "Old" })],
    ];
    expect(
      withProductPageConfig(tags, { metaTitle: "New" }).filter(
        (tag) => tag[0] === "page_config"
      )
    ).toHaveLength(1);
    expect(
      withProductPageConfig(tags, null).some((tag) => tag[0] === "page_config")
    ).toBe(false);
  });
});

describe("normalizeMarketplaceDiscoveryTag", () => {
  it("strips both spellings and appends one canonical tag", () => {
    expect(
      normalizeMarketplaceDiscoveryTag([
        ["t", "MilkMarket"],
        ["t", "SelfSown"],
        ["t", "FREEMILK"],
        ["t", "raw-milk"],
        ["d", "abc"],
      ])
    ).toEqual([
      ["t", "FREEMILK"],
      ["t", "raw-milk"],
      ["d", "abc"],
      ["t", "SelfSown"],
    ]);
  });
});

describe("PRODUCT_PAGE_CONFIG_FIELDS", () => {
  it("covers exactly the five persisted keys", () => {
    expect([...PRODUCT_PAGE_CONFIG_FIELDS].sort()).toEqual([
      "metaDescription",
      "metaTitle",
      "ogImage",
      "sections",
      "themeOverrides",
    ]);
  });
});
