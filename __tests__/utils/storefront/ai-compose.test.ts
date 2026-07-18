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
  // A text-only source hero region: drafts only get a hero section when the
  // source page actually had one.
  hero: {
    heading: "Green Valley Farm",
    subheading: "Raw milk from pastured cows.",
  },
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
      hero: { heading: "Green Valley Farm" },
    });
    const merged = await composeStoreDesignWithAI(s, buildExtractionDraft(s));

    const hero = merged!.storefront.sections!.find((x) => x.type === "hero")!;
    expect(hero.heading).toBe("Green Valley Farm");
    expect(hero.subheading).toBe("AI subheading.");
    expect(merged!.storefront.seoMeta?.metaDescription).toBe(
      "AI meta description."
    );
  });

  test("extracted brand colors win over the AI palette", async () => {
    mockLLM.mockResolvedValue({
      ...AI_RESPONSE,
      colorScheme: {
        primary: "#123456",
        secondary: "#234567",
        accent: "#345678",
        background: "#f0f0f0",
        text: "#0a0a0a",
      },
      navColors: { background: "#111111", text: "#eeeeee", accent: "#123456" },
      fontHeading: "Playfair Display",
    });
    const s = signals({ colors: ["#bd0000", "#fafafa"], fonts: ["Oswald"] });
    const base = buildExtractionDraft(s);
    const merged = await composeStoreDesignWithAI(s, base);

    expect(merged!.storefront.colorScheme).toEqual(base.storefront.colorScheme);
    expect(merged!.storefront.navColors).toEqual(base.storefront.navColors);
    expect(merged!.storefront.footerColors).toEqual(
      base.storefront.footerColors
    );
    // Extracted (mapped) font also beats the AI's pick.
    expect(merged!.storefront.fontHeading).toBe(base.storefront.fontHeading);
  });

  test("AI palette applies only when extraction found no brand colors", async () => {
    mockLLM.mockResolvedValue({
      ...AI_RESPONSE,
      colorScheme: {
        primary: "#123456",
        secondary: "#234567",
        accent: "#345678",
        background: "#f0f0f0",
        text: "#0a0a0a",
      },
    });
    const s = signals({ colors: [] });
    const merged = await composeStoreDesignWithAI(s, buildExtractionDraft(s));

    expect(merged!.storefront.colorScheme?.primary).toBe("#123456");
  });

  test("dark source header keeps the deterministic dark nav even without extracted brand colors", async () => {
    mockLLM.mockResolvedValue({
      ...AI_RESPONSE,
      navColors: { background: "#fafafa", text: "#0a0a0a", accent: "#123456" },
    });
    const s = signals({ colors: [], headerTheme: "dark" });
    const base = buildExtractionDraft(s);
    const merged = await composeStoreDesignWithAI(s, base);

    expect(base.storefront.navColors!.background).toBe("#111111");
    expect(merged!.storefront.navColors).toEqual(base.storefront.navColors);
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
