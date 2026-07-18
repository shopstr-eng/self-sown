import {
  buildExtractionDraft,
  buildProductPageDraft,
  type ExtractedSiteSignals,
} from "@/utils/migrations/site-design";

const baseSignals = (
  over: Partial<ExtractedSiteSignals> = {}
): ExtractedSiteSignals => ({
  url: "https://farm.example/",
  siteName: "Green Valley Farm",
  description: "Raw milk from pastured cows.",
  colors: [],
  fonts: [],
  socialLinks: [],
  images: [],
  contentBlocks: [],
  ...over,
});

describe("buildExtractionDraft imported hero", () => {
  test("emits a clean full-width banner_carousel from the hero-region image (no icon, no fake text, no CTA)", () => {
    const draft = buildExtractionDraft(
      baseSignals({
        hero: { image: "https://farm.example/hero.jpg" },
        ogImage: "https://farm.example/og.jpg",
      })
    );

    const first = draft.storefront.sections![0];
    expect(first).toEqual({
      id: "imported-banner",
      type: "banner_carousel",
      enabled: true,
      fullWidth: true,
      contentWidth: "full",
      imageHeight: "auto",
      bannerSlides: [{ image: "https://farm.example/hero.jpg" }],
    });
    // Shop banner pre-fill follows the same image.
    expect(draft.bannerUrl).toBe("https://farm.example/hero.jpg");
  });

  test("overlays only the source page's real hero text", () => {
    const draft = buildExtractionDraft(
      baseSignals({
        hero: {
          image: "https://farm.example/hero.jpg",
          heading: "Fresh From Our Pastures",
          subheading: "Family farmed since 1952.",
        },
      })
    );

    const first = draft.storefront.sections![0];
    expect(first.type).toBe("banner_carousel");
    expect(first.bannerSlides).toEqual([
      {
        image: "https://farm.example/hero.jpg",
        heading: "Fresh From Our Pastures",
        subheading: "Family farmed since 1952.",
      },
    ]);
    expect(first.overlayOpacity).toBeCloseTo(0.35);
  });

  test("never fabricates a banner from the OG image — it only pre-fills the shop banner", () => {
    const ogDraft = buildExtractionDraft(
      baseSignals({ ogImage: "https://farm.example/og.jpg" })
    );
    expect(
      ogDraft.storefront.sections!.some((s) => s.type === "banner_carousel")
    ).toBe(false);
    expect(ogDraft.bannerUrl).toBe("https://farm.example/og.jpg");
    expect(ogDraft.storefront.seoMeta?.ogImage).toBe(
      "https://farm.example/og.jpg"
    );
  });

  test("recreates a text hero from the source hero region's own words when it has no image", () => {
    const draft = buildExtractionDraft(
      baseSignals({
        hero: {
          heading: "Milk Worth The Drive",
          subheading: "From our pastures to your table.",
        },
      })
    );
    const first = draft.storefront.sections![0];
    expect(first.type).toBe("hero");
    expect(first.heading).toBe("Milk Worth The Drive");
    expect(first.subheading).toBe("From our pastures to your table.");
  });

  test("a page with content but no hero region gets NO fabricated hero", () => {
    const draft = buildExtractionDraft(
      baseSignals({
        contentBlocks: [
          { heading: "Our Story", body: "B".repeat(80), pos: 100 },
        ],
      })
    );
    const types = draft.storefront.sections!.map((s) => s.type);
    expect(types).not.toContain("hero");
    expect(types).not.toContain("banner_carousel");
  });

  test("falls back to a minimal text hero only when the page yielded no sections at all", () => {
    const bareDraft = buildExtractionDraft(
      baseSignals({ aboutText: undefined, description: undefined })
    );
    const sections = bareDraft.storefront.sections!;
    expect(sections).toHaveLength(1);
    expect(sections[0].type).toBe("hero");
    expect(sections[0].heading).toBe("Green Valley Farm");
  });

  test("turns extracted YouTube videos into a social_posts section", () => {
    const draft = buildExtractionDraft(
      baseSignals({
        videos: [
          "https://www.youtube.com/watch?v=abc123def",
          "https://www.youtube.com/watch?v=xyz789ghi",
        ],
      })
    );

    const videos = draft.storefront.sections!.find(
      (s) => s.type === "social_posts"
    );
    expect(videos).toBeDefined();
    expect(videos!.socialPostsLayout).toBe("grid");
    expect(videos!.socialPosts).toEqual([
      { platform: "youtube", url: "https://www.youtube.com/watch?v=abc123def" },
      { platform: "youtube", url: "https://www.youtube.com/watch?v=xyz789ghi" },
    ]);
  });

  test("omits the social_posts section when no videos were found", () => {
    const draft = buildExtractionDraft(baseSignals());
    expect(
      draft.storefront.sections!.some((s) => s.type === "social_posts")
    ).toBe(false);
  });
});

describe("buildExtractionDraft dark header", () => {
  test("an explicitly dark source header yields a dark nav", () => {
    const draft = buildExtractionDraft(baseSignals({ headerTheme: "dark" }));
    expect(draft.storefront.navColors).toMatchObject({
      background: "#111111",
      text: "#ffffff",
    });
  });

  test("nav follows page colors when the header is not dark", () => {
    const draft = buildExtractionDraft(baseSignals());
    expect(draft.storefront.navColors!.background).not.toBe("#111111");
  });
});

describe("buildExtractionDraft testimonials + source order", () => {
  test("builds a testimonials section from extracted quotes with the source heading", () => {
    const draft = buildExtractionDraft(
      baseSignals({
        testimonials: {
          heading: "Customer Reviews",
          quotes: [
            { quote: "Best milk ever, truly.", author: "Alice" },
            { quote: "We drive an hour for this." },
          ],
          pos: 500,
        },
      })
    );
    const t = draft.storefront.sections!.find(
      (s) => s.type === "testimonials"
    )!;
    expect(t).toBeDefined();
    expect(t.id).toBe("imported-testimonials");
    expect(t.heading).toBe("Customer Reviews");
    expect(t.testimonials).toEqual([
      { quote: "Best milk ever, truly.", author: "Alice" },
      { quote: "We drive an hour for this.", author: "" },
    ]);
  });

  test("skips the testimonials section for fewer than two quotes", () => {
    const draft = buildExtractionDraft(
      baseSignals({
        testimonials: { quotes: [{ quote: "Only one quote here." }] },
      })
    );
    expect(
      draft.storefront.sections!.some((s) => s.type === "testimonials")
    ).toBe(false);
  });

  test("orders text/image/testimonial sections by their source position", () => {
    const draft = buildExtractionDraft(
      baseSignals({
        hero: { image: "https://farm.example/hero.jpg" },
        aboutText: "A long about text that fills the about section nicely.",
        contentBlocks: [
          { heading: "Late Block", body: "B".repeat(60), pos: 900 },
          { heading: "Early Block", body: "A".repeat(60), pos: 100 },
        ],
        images: [
          { url: "https://farm.example/one.jpg", pos: 50 },
          { url: "https://farm.example/two.jpg", pos: 950 },
        ],
        testimonials: {
          heading: "Reviews",
          quotes: [
            { quote: "So good we moved closer." },
            { quote: "Five stars from our family." },
          ],
          pos: 500,
        },
      })
    );
    // one.jpg is consumed as the about-section image; the remaining pieces
    // are ordered by pos: Early(100) < Reviews(500) < Late(900) < two.jpg(950).
    const rest = draft.storefront.sections!.filter((s) =>
      ["text", "image", "testimonials"].includes(s.type)
    );
    expect(rest.map((s) => s.heading ?? s.image)).toEqual([
      "Early Block",
      "Reviews",
      "Late Block",
      "https://farm.example/two.jpg",
    ]);
  });
});

describe("buildExtractionDraft layout fidelity", () => {
  test("image sections go full-width only on explicit full-bleed evidence", () => {
    const draft = buildExtractionDraft(
      baseSignals({
        hero: { image: "https://farm.example/hero.jpg" },
        images: [
          // First image gets consumed as the about-section photo.
          { url: "https://farm.example/about.jpg", pos: 50 },
          { url: "https://farm.example/wide.jpg", pos: 100, fullBleed: true },
          { url: "https://farm.example/inline.jpg", pos: 200 },
        ],
      })
    );
    const imageSections = draft.storefront.sections!.filter(
      (s) => s.type === "image"
    );
    const wide = imageSections.find(
      (s) => s.image === "https://farm.example/wide.jpg"
    )!;
    expect(wide.fullWidth).toBe(true);
    expect(wide.contentWidth).toBe("full");
    expect(wide.imageHeight).toBe("auto");
    const inline = imageSections.find(
      (s) => s.image === "https://farm.example/inline.jpg"
    )!;
    expect(inline.fullWidth).toBeUndefined();
    expect(inline.contentWidth).toBeUndefined();
  });

  test("text sections reproduce the source's color band with readable text", () => {
    const draft = buildExtractionDraft(
      baseSignals({
        contentBlocks: [
          {
            heading: "Dark Band",
            body: "C".repeat(80),
            pos: 100,
            backgroundColor: "#112233",
          },
          { heading: "Plain Block", body: "D".repeat(80), pos: 200 },
        ],
      })
    );
    const texts = draft.storefront.sections!.filter((s) => s.type === "text");
    const dark = texts.find((s) => s.heading === "Dark Band")!;
    expect(dark.backgroundColor).toBe("#112233");
    expect(dark.textColor).toBe("#ffffff");
    const plain = texts.find((s) => s.heading === "Plain Block")!;
    expect(plain.backgroundColor).toBeUndefined();
    expect(plain.textColor).toBeUndefined();
  });

  test("emits a real products section where the source's product grid sits", () => {
    const draft = buildExtractionDraft(
      baseSignals({
        products: [
          { title: "Raw Milk", price: 8, currency: "USD" },
          { title: "Butter", price: 12, currency: "USD" },
          { title: "Kefir", price: 9, currency: "USD" },
        ],
        productsPos: 150,
        contentBlocks: [
          { heading: "Early Block", body: "A".repeat(60), pos: 100 },
          { heading: "Late Block", body: "B".repeat(60), pos: 900 },
        ],
      })
    );
    const sections = draft.storefront.sections!;
    const idx = sections.findIndex((s) => s.type === "products");
    expect(idx).toBeGreaterThan(-1);
    expect(sections[idx].id).toBe("imported-products");
    // Ordered by source position: Early(100) < products(150) < Late(900).
    expect(sections[idx - 1]?.heading).toBe("Early Block");
    expect(sections[idx + 1]?.heading).toBe("Late Block");
    // Scraped cards stay preview-only sample products.
    expect(draft.sampleProducts).toHaveLength(3);
  });

  test("omits the products section when no product cards were found", () => {
    const draft = buildExtractionDraft(baseSignals());
    expect(draft.storefront.sections!.some((s) => s.type === "products")).toBe(
      false
    );
  });
});

describe("buildProductPageDraft lead image", () => {
  test("leads with the hero-region image and dedups it from the content images", () => {
    const draft = buildProductPageDraft(
      baseSignals({
        title: "Raw Milk Gallon",
        hero: { image: "https://farm.example/product-hero.jpg" },
        images: [
          { url: "https://farm.example/product-hero.jpg" },
          { url: "https://farm.example/other.jpg", alt: "Bottling" },
        ],
      })
    );

    const imageSections = draft.sections.filter((s) => s.type === "image");
    expect(imageSections[0].image).toBe(
      "https://farm.example/product-hero.jpg"
    );
    expect(imageSections.map((s) => s.image)).toEqual([
      "https://farm.example/product-hero.jpg",
      "https://farm.example/other.jpg",
    ]);
  });
});
