import { composeStoreDesignWithAI } from "@/utils/storefront/ai-compose";
import {
  buildExtractionDraft,
  type ExtractedSiteSignals,
} from "@/utils/migrations/site-design";
import { callLLMJson } from "@/utils/storefront/llm-json";

jest.mock("@/utils/storefront/llm-json", () => ({
  callLLMJson: jest.fn(),
}));

const mockLLM = callLLMJson as jest.Mock;

const signals = (
  over: Partial<ExtractedSiteSignals> = {}
): ExtractedSiteSignals => ({
  url: "https://farm.example/",
  siteName: "Green Valley Farm",
  description: "Raw milk from pastured cows.",
  aboutText: "We are a small family farm selling raw milk and cheese.",
  colors: [],
  fonts: [],
  socialLinks: [],
  images: [],
  contentBlocks: [],
  ...over,
});

const AI_RESPONSE = {
  heroHeading: "AI Headline",
  heroSubheading: "AI subheading.",
  heroCtaText: "AI CTA",
  aboutHeading: "AI About",
  aboutBody: "AI-written about copy.",
  metaTitle: "AI Meta Title",
  metaDescription: "AI meta description.",
};

describe("composeStoreDesignWithAI copy precedence", () => {
  beforeEach(() => {
    mockLLM.mockReset();
    mockLLM.mockResolvedValue(AI_RESPONSE);
  });

  test("extracted copy wins over AI copy; AI only gap-fills missing fields", async () => {
    const s = signals();
    const merged = await composeStoreDesignWithAI(s, buildExtractionDraft(s));

    expect(merged).not.toBeNull();
    const sections = merged!.storefront.sections!;
    const hero = sections.find((x) => x.type === "hero")!;
    // Extracted site name/description beat the AI rewrite.
    expect(hero.heading).toBe("Green Valley Farm");
    expect(hero.subheading).toBe("Raw milk from pastured cows.");
    const about = sections.find((x) => x.type === "about")!;
    expect(about.body).toBe(
      "We are a small family farm selling raw milk and cheese."
    );
    expect(merged!.storefront.seoMeta?.metaTitle).toBe("Green Valley Farm");
    expect(merged!.storefront.seoMeta?.metaDescription).toBe(
      "Raw milk from pastured cows."
    );
  });

  test("AI gap-fills fields the source page did not provide", async () => {
    const s = signals({
      siteName: "Green Valley Farm",
      description: undefined,
      aboutText: undefined,
    });
    const merged = await composeStoreDesignWithAI(s, buildExtractionDraft(s));

    const hero = merged!.storefront.sections!.find((x) => x.type === "hero")!;
    expect(hero.heading).toBe("Green Valley Farm");
    expect(hero.subheading).toBe("AI subheading.");
    expect(merged!.storefront.seoMeta?.metaDescription).toBe(
      "AI meta description."
    );
  });

  test("never rewrites the imported banner_carousel overlay", async () => {
    const s = signals({ hero: { image: "https://farm.example/hero.jpg" } });
    const merged = await composeStoreDesignWithAI(s, buildExtractionDraft(s));

    const banner = merged!.storefront.sections!.find(
      (x) => x.type === "banner_carousel"
    )!;
    expect(banner.bannerSlides).toEqual([
      { image: "https://farm.example/hero.jpg" },
    ]);
    expect(banner.heading).toBeUndefined();
  });
});
