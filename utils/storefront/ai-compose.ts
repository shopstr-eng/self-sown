import {
  IMPORT_FONT_ALLOWLIST,
  isValidHexColor,
  capText,
  type ExtractedSiteSignals,
  type ImportedStoreDesign,
} from "@/utils/migrations/site-design";
import type {
  StorefrontColorScheme,
  StorefrontNavColors,
  StorefrontFooterColors,
  StorefrontSection,
} from "@/utils/types/types";
import { callLLMJson } from "@/utils/storefront/llm-json";

// Turns the raw extracted signals into a polished stall design using an LLM.
// The LLM ONLY composes palette, font choices and copy — never URLs. Images,
// social links and the source URL always come from deterministic extraction,
// so the model can't inject links. Every field is validated/sanitized before
// it touches a StorefrontConfig. On any failure this returns null and the
// caller falls back to the deterministic draft (fail-closed / fail-open UX).

interface AiDesignResponse {
  colorScheme?: Partial<StorefrontColorScheme>;
  navColors?: Partial<StorefrontNavColors>;
  footerColors?: Partial<StorefrontFooterColors>;
  fontHeading?: string;
  fontBody?: string;
  heroHeading?: string;
  heroSubheading?: string;
  heroCtaText?: string;
  aboutHeading?: string;
  aboutBody?: string;
  metaTitle?: string;
  metaDescription?: string;
}

function buildPrompt(signals: ExtractedSiteSignals): {
  system: string;
  user: string;
} {
  const system = [
    "You are a brand designer helping a food/farm seller move their existing",
    "website onto a new storefront. Given raw signals scraped from their site,",
    "produce a cohesive, tasteful design and marketing copy.",
    "Rules:",
    "- Return ONLY JSON matching the requested schema. No prose.",
    "- All colors MUST be 6-digit hex (e.g. #1a2b3c).",
    "- Fonts MUST be chosen from this exact list: " +
      IMPORT_FONT_ALLOWLIST.join(", ") +
      ".",
    "- Never invent URLs, links, emails or image paths.",
    "- Keep copy warm, concise and specific to the brand; no lorem ipsum.",
    "- Ensure text colors contrast strongly against their backgrounds.",
  ].join("\n");

  const user = JSON.stringify({
    siteName: signals.siteName,
    title: signals.title,
    description: signals.description,
    aboutText: capText(signals.aboutText, 1200) || undefined,
    dominantColors: signals.colors,
    themeColor: signals.themeColor,
    fontsSeen: signals.fonts,
    schema: {
      colorScheme: {
        primary: "#hex",
        secondary: "#hex",
        accent: "#hex",
        background: "#hex",
        text: "#hex",
      },
      navColors: { background: "#hex", text: "#hex", accent: "#hex" },
      footerColors: { background: "#hex", text: "#hex", accent: "#hex" },
      fontHeading: "one of the allowed fonts",
      fontBody: "one of the allowed fonts",
      heroHeading: "short punchy headline",
      heroSubheading: "one supporting sentence",
      heroCtaText: "2-3 word button label",
      aboutHeading: "short heading",
      aboutBody: "2-4 sentence about paragraph",
      metaTitle: "SEO title, <= 65 chars",
      metaDescription: "SEO description, <= 155 chars",
    },
  });

  return { system, user };
}

function safeColor(value: unknown): string | undefined {
  return isValidHexColor(value) ? (value as string).toLowerCase() : undefined;
}

function safeFont(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return IMPORT_FONT_ALLOWLIST.find(
    (f) => f.toLowerCase() === value.trim().toLowerCase()
  );
}

function mergeColorScheme(
  base: StorefrontColorScheme,
  ai?: Partial<StorefrontColorScheme>
): StorefrontColorScheme {
  if (!ai) return base;
  return {
    primary: safeColor(ai.primary) ?? base.primary,
    secondary: safeColor(ai.secondary) ?? base.secondary,
    accent: safeColor(ai.accent) ?? base.accent,
    background: safeColor(ai.background) ?? base.background,
    text: safeColor(ai.text) ?? base.text,
  };
}

function mergeTriColors<
  T extends { background: string; text: string; accent: string },
>(base: T | undefined, ai: Partial<T> | undefined): T | undefined {
  if (!base) return base;
  if (!ai) return base;
  return {
    ...base,
    background: safeColor(ai.background) ?? base.background,
    text: safeColor(ai.text) ?? base.text,
    accent: safeColor(ai.accent) ?? base.accent,
  };
}

function applyCopyToSections(
  sections: StorefrontSection[] | undefined,
  ai: AiDesignResponse
): StorefrontSection[] | undefined {
  if (!sections) return sections;
  return sections.map((section) => {
    if (section.type === "hero") {
      return {
        ...section,
        heading: capText(ai.heroHeading, 80) || section.heading,
        subheading: capText(ai.heroSubheading, 160) || section.subheading,
        ctaText: capText(ai.heroCtaText, 24) || section.ctaText,
      };
    }
    if (section.type === "about") {
      return {
        ...section,
        heading: capText(ai.aboutHeading, 60) || section.heading,
        body: capText(ai.aboutBody, 800) || section.body,
      };
    }
    return section;
  });
}

/**
 * Enhance a deterministic draft with AI-composed palette + copy. Returns null
 * when the LLM is unavailable or returns anything unusable; the caller keeps
 * the deterministic draft in that case.
 */
export async function composeStoreDesignWithAI(
  signals: ExtractedSiteSignals,
  baseDraft: ImportedStoreDesign
): Promise<ImportedStoreDesign | null> {
  const { system, user } = buildPrompt(signals);

  let raw: unknown;
  try {
    raw = await callLLMJson(system, user);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;

  const ai = raw as AiDesignResponse;

  const baseScheme = baseDraft.storefront.colorScheme;
  const colorScheme = baseScheme
    ? mergeColorScheme(baseScheme, ai.colorScheme)
    : baseScheme;

  const merged: ImportedStoreDesign = {
    ...baseDraft,
    storefront: {
      ...baseDraft.storefront,
      colorScheme,
      navColors: mergeTriColors(baseDraft.storefront.navColors, ai.navColors),
      footerColors: mergeTriColors(
        baseDraft.storefront.footerColors,
        ai.footerColors
      ),
      fontHeading: safeFont(ai.fontHeading) ?? baseDraft.storefront.fontHeading,
      fontBody: safeFont(ai.fontBody) ?? baseDraft.storefront.fontBody,
      sections: applyCopyToSections(baseDraft.storefront.sections, ai),
      seoMeta: {
        ...baseDraft.storefront.seoMeta,
        metaTitle:
          capText(ai.metaTitle, 70) || baseDraft.storefront.seoMeta?.metaTitle,
        metaDescription:
          capText(ai.metaDescription, 160) ||
          baseDraft.storefront.seoMeta?.metaDescription,
      },
    },
    aiApplied: true,
  };

  return merged;
}
