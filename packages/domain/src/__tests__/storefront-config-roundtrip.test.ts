import { parseSellerShopProfileEvent } from "../seller";

// Guards the design-field round-trip every save path depends on: the web
// form re-derives these fields from its own state, but the mobile editors
// (and any other consumer of parseSellerShopProfileEvent) re-publish the
// normalized config — so a field the normalizer drops is deleted on save.
// If you add a StorefrontConfig field, extend this fixture.
describe("normalizeStorefrontConfig design-field round-trip", () => {
  const storefront = {
    colorScheme: {
      primary: "#111111",
      secondary: "#222222",
      accent: "#333333",
      background: "#ffffff",
      text: "#000000",
    },
    navColors: { background: "#111111", text: "#eeeeee", accent: "#d4a017" },
    footerColors: { background: "#000000", text: "#dddddd", accent: "#b08968" },
    neoShadows: true,
    hideShopLink: true,
    customFontHeadingUrl: "https://fonts.example.com/heading.woff2",
    customFontHeadingName: "Custom Heading",
    customFontBodyUrl: "https://fonts.example.com/body.woff2",
    customFontBodyName: "Custom Body",
    seoMeta: {
      metaTitle: "Farm shop",
      metaDescription: "Local food",
      ogImage: "https://example.com/og.png",
      keywords: "farm, local",
      locale: "en_US",
      locationRegion: "OR",
      locationCity: "Portland",
      autoGenerate: true,
    },
    emailPopup: {
      enabled: true,
      discountPercentage: 10,
      headline: "Join us",
      style: { backgroundColor: "#ffffff" },
      flowSteps: [
        { id: "s1", question: "Hi?", answers: [{ id: "a1", label: "Yes" }] },
      ],
      junkKey: "must not persist",
    },
    assistantVisibility: { buyers: true, seller: false },
    showBlogPage: true,
    sections: [{ id: "s1", type: "hero", heading: "Welcome" }],
  };

  function parse(content: Record<string, unknown>) {
    return parseSellerShopProfileEvent({
      id: "e1",
      kind: 30019,
      pubkey: "f".repeat(64),
      created_at: 1,
      content: JSON.stringify(content),
      tags: [],
    });
  }

  it("preserves every design field through parse", () => {
    const parsed = parse({
      name: "Shop",
      about: "",
      ui: {},
      merchants: ["f".repeat(64)],
      storefront,
    });
    const result = parsed?.content.storefront;
    expect(result).toBeDefined();
    expect(result?.navColors).toEqual(storefront.navColors);
    expect(result?.footerColors).toEqual(storefront.footerColors);
    expect(result?.neoShadows).toBe(true);
    expect(result?.hideShopLink).toBe(true);
    expect(result?.customFontHeadingUrl).toBe(storefront.customFontHeadingUrl);
    expect(result?.customFontHeadingName).toBe(
      storefront.customFontHeadingName
    );
    expect(result?.customFontBodyUrl).toBe(storefront.customFontBodyUrl);
    expect(result?.customFontBodyName).toBe(storefront.customFontBodyName);
    expect(result?.seoMeta).toEqual(storefront.seoMeta);
    expect(result?.assistantVisibility).toEqual(storefront.assistantVisibility);
    expect(result?.emailPopup?.enabled).toBe(true);
    expect(result?.emailPopup?.discountPercentage).toBe(10);
    expect(result?.emailPopup?.style?.backgroundColor).toBe("#ffffff");
    expect(result?.emailPopup?.flowSteps).toHaveLength(1);
    expect(
      (result?.emailPopup as Record<string, unknown> | undefined)?.junkKey
    ).toBeUndefined();
    expect(result?.sections).toHaveLength(1);
  });

  it("drops malformed color sets and junk popups", () => {
    const parsed = parse({
      name: "Shop",
      about: "",
      ui: {},
      merchants: [],
      storefront: {
        navColors: { background: "#111111" },
        emailPopup: { headline: "no enabled flag" },
        seoMeta: {},
      },
    });
    const result = parsed?.content.storefront;
    expect(result?.navColors).toBeUndefined();
    expect(result?.emailPopup).toBeUndefined();
    expect(result?.seoMeta).toBeUndefined();
  });
});
