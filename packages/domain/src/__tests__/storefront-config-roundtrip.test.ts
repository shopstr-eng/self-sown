import { parseSellerShopProfileEvent } from "../seller";
import type { StorefrontConfig } from "../storefront";

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

  // The carry-over contract behind web/mobile parity: every StorefrontConfig
  // key set to a non-default value must survive parseSellerShopProfileEvent
  // intact, because re-publishing clients (the mobile design editor, MCP
  // tools) re-publish the normalized config — a key the normalizer drops is
  // deleted on their next save. The fixture is Required<StorefrontConfig>, so
  // adding a key to the interface is a COMPILE error here until it gets a
  // fixture value, and toMatchObject fails if its value is dropped or
  // mutated. Values are chosen to survive documented normalizer semantics:
  // hideShopLink persists only as true, acceptBitcoin only as false,
  // acceptsEscrow only as true, collections must be non-empty, and URLs are
  // pre-sanitized https.
  it("carries every StorefrontConfig key through parse (maximal fixture)", () => {
    const full: Required<StorefrontConfig> = {
      colorScheme: {
        primary: "#111111",
        secondary: "#222222",
        accent: "#333333",
        background: "#ffffff",
        text: "#000000",
      },
      productLayout: "featured",
      landingPageStyle: "hero",
      landingPageMode: "product",
      landingProductDTag: "landing-product",
      shopSlug: "full-shop",
      customDomain: "shop.example.com",
      fontHeading: "serif",
      fontBody: "sans",
      customFontHeadingUrl: "https://fonts.example.com/heading.woff2",
      customFontHeadingName: "Custom Heading",
      customFontBodyUrl: "https://fonts.example.com/body.woff2",
      customFontBodyName: "Custom Body",
      neoShadows: true,
      sections: [{ id: "s1", type: "hero", heading: "Welcome" }],
      pages: [
        {
          id: "p1",
          title: "About",
          slug: "about",
          sections: [{ id: "p1s1", type: "text", heading: "Hi" }],
        },
      ],
      footer: {
        text: "Thanks for visiting",
        showPoweredBy: false,
        showNip05: true,
        navLinks: [{ label: "Contact", href: "https://example.com/contact" }],
        socialLinks: [
          {
            platform: "instagram",
            url: "https://instagram.com/shop",
            label: "IG",
          },
        ],
        policies: {
          returnPolicy: { enabled: true, content: "30 days" },
          termsOfService: { enabled: true, content: "Terms" },
          privacyPolicy: { enabled: false, content: "Privacy" },
          cancellationPolicy: { enabled: true, content: "Cancel anytime" },
        },
        newsletter: {
          enabled: true,
          headline: "Join",
          subtext: "Updates",
          buttonText: "Subscribe",
          placeholder: "you@example.com",
          successMessage: "Thanks!",
          collectPhone: true,
        },
        layout: {
          alignment: "center",
          linkSpacing: "spacious",
          columnLayout: "stacked",
        },
      },
      navLinks: [{ label: "Home", href: "/", isPage: false }],
      hideShopLink: true,
      showCommunityPage: true,
      showWalletPage: true,
      showBlogPage: true,
      blogPage: { sections: [{ id: "b1", type: "blog", heading: "Blog" }] },
      productPageDefaults: [
        { id: "pd1", type: "product_description", heading: "About this item" },
      ],
      emailPopup: {
        enabled: true,
        displayMode: "fullscreen",
        discountPercentage: 15,
        shippingDiscountType: "percent",
        shippingDiscountValue: 50,
        headline: "Join us",
        subtext: "Get a discount",
        collectPhone: true,
        requirePhone: false,
        buttonText: "Claim",
        successMessage: "Done",
        style: {
          backgroundColor: "#ffffff",
          textColor: "#000000",
          accentColor: "#333333",
          buttonColor: "#111111",
          buttonTextColor: "#ffffff",
          backgroundImage: "https://example.com/bg.png",
          overlayOpacity: 0.4,
          useCustomFonts: true,
        },
        flowSteps: [
          {
            id: "s1",
            question: "Hi?",
            answers: [{ id: "a1", label: "Yes", nextStepId: "s2" }],
          },
        ],
      },
      assistantVisibility: { buyers: false, seller: true },
      navColors: { background: "#111111", text: "#eeeeee", accent: "#d4a017" },
      navLayout: {
        logoPosition: "center",
        linkAlignment: "left",
        linkSpacing: "compact",
        utilityPosition: "bottom",
        transparent: true,
        hideOnScroll: true,
      },
      footerColors: {
        background: "#000000",
        text: "#dddddd",
        accent: "#b08968",
      },
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
      paymentMethodOrder: ["card", "bitcoin"],
      acceptBitcoin: false,
      acceptsEscrow: true,
    };
    const result = parse({
      name: "Shop",
      about: "",
      ui: {},
      merchants: ["f".repeat(64)],
      storefront: full,
    })?.content.storefront;
    expect(result).toMatchObject(full);
  });
});
