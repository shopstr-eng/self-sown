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

  test("falls back to the OG image, then to a text hero when the site has no images", () => {
    const ogDraft = buildExtractionDraft(
      baseSignals({ ogImage: "https://farm.example/og.jpg" })
    );
    expect(ogDraft.storefront.sections![0].type).toBe("banner_carousel");
    expect(ogDraft.storefront.sections![0].bannerSlides![0].image).toBe(
      "https://farm.example/og.jpg"
    );

    const bareDraft = buildExtractionDraft(baseSignals());
    const first = bareDraft.storefront.sections![0];
    expect(first.type).toBe("hero");
    expect(first.heading).toBe("Green Valley Farm");
    expect(first.subheading).toBe("Raw milk from pastured cows.");
    expect(first.image).toBeUndefined();
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
