import type {
  StorefrontColorScheme,
  StorefrontNavColors,
  StorefrontFooterColors,
  StorefrontSection,
  StorefrontSocialLink,
  StorefrontSeoMeta,
} from "@/utils/types/types";

// Shared, dependency-light types + pure helpers for the "import stall design
// from a website URL" feature. This module MUST stay free of server-only
// imports (no dns/net/fs) so both the server extractor and the client wizard
// can import it. Network + HTML parsing live in ./site-design-extractor.ts.

// Keep in lockstep with the GOOGLE_FONT_OPTIONS lists used by the storefront
// renderers/theme wrapper. Any font we suggest must be one the storefront can
// actually load.
export const IMPORT_FONT_ALLOWLIST = [
  "Inter",
  "Roboto",
  "Open Sans",
  "Lato",
  "Montserrat",
  "Poppins",
  "Playfair Display",
  "Merriweather",
  "Raleway",
  "Nunito",
  "Oswald",
  "Source Sans 3",
  "PT Serif",
  "Bitter",
  "Crimson Text",
] as const;

// Common non-Google fonts mapped to the closest allow-listed substitute so a
// site using system/paid fonts still yields a sensible suggestion.
const FONT_SUBSTITUTIONS: Record<string, string> = {
  helvetica: "Inter",
  "helvetica neue": "Inter",
  arial: "Inter",
  "sans-serif": "Inter",
  system: "Inter",
  "-apple-system": "Inter",
  segoe: "Inter",
  "segoe ui": "Inter",
  roboto: "Roboto",
  georgia: "PT Serif",
  times: "Merriweather",
  "times new roman": "Merriweather",
  garamond: "Crimson Text",
  serif: "Merriweather",
  futura: "Montserrat",
  gotham: "Montserrat",
  "gill sans": "Raleway",
  avenir: "Nunito",
};

export interface ExtractedSiteSignals {
  url: string;
  siteName?: string;
  title?: string;
  description?: string;
  aboutText?: string;
  ogImage?: string;
  logoUrl?: string;
  faviconUrl?: string;
  themeColor?: string;
  colors: string[];
  fonts: string[];
  socialLinks: StorefrontSocialLink[];
}

export interface ImportedStorefrontDraft {
  colorScheme?: StorefrontColorScheme;
  navColors?: StorefrontNavColors;
  footerColors?: StorefrontFooterColors;
  fontHeading?: string;
  fontBody?: string;
  landingPageStyle?: "classic" | "hero" | "minimal";
  sections?: StorefrontSection[];
  footer?: { socialLinks?: StorefrontSocialLink[] };
  seoMeta?: StorefrontSeoMeta;
}

// localStorage key used to hand a finished draft from the import wizard to the
// shop-profile-form (which applies it via the normal Save path). Keeping the
// key in the shared module keeps the writer and reader in lockstep.
export const IMPORT_DESIGN_DRAFT_KEY = "mm_import_design_draft";

export interface ImportedStoreDesign {
  sourceUrl: string;
  name?: string;
  about?: string;
  logoUrl?: string;
  bannerUrl?: string;
  storefront: ImportedStorefrontDraft;
  aiApplied: boolean;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

export function normalizeHexColor(input: string): string | null {
  const value = input.trim().toLowerCase();

  const hexMatch = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (hexMatch) {
    const hex = hexMatch[1]!;
    if (hex.length === 3) {
      return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
    }
    return `#${hex}`;
  }

  const rgbMatch = value.match(
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/
  );
  if (rgbMatch) {
    const [r, g, b] = [rgbMatch[1], rgbMatch[2], rgbMatch[3]].map((n) =>
      Math.max(0, Math.min(255, parseInt(n!, 10)))
    );
    return `#${[r, g, b]
      .map((n) => n!.toString(16).padStart(2, "0"))
      .join("")}`;
  }

  return null;
}

export function isValidHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Pick a readable text color (near-black / near-white) for a background. */
export function contrastText(backgroundHex: string): string {
  return relativeLuminance(backgroundHex) > 0.5 ? "#111111" : "#ffffff";
}

function saturation(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => c / 255) as [
    number,
    number,
    number,
  ];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === 0) return 0;
  return (max - min) / max;
}

/** A color that reads as a "brand" color: saturated and not near-white/black. */
function isBrandColor(hex: string): boolean {
  const lum = relativeLuminance(hex);
  return saturation(hex) > 0.18 && lum > 0.03 && lum < 0.92;
}

// ---------------------------------------------------------------------------
// Font helpers
// ---------------------------------------------------------------------------

export function mapToAllowedFont(family: string): string | null {
  const first = family.split(",")[0]?.replace(/["']/g, "").trim().toLowerCase();
  if (!first) return null;

  const exact = IMPORT_FONT_ALLOWLIST.find((f) => f.toLowerCase() === first);
  if (exact) return exact;

  const sub = FONT_SUBSTITUTIONS[first];
  if (sub) return sub;

  return null;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

export function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function capText(value: string | undefined, max: number): string {
  if (!value) return "";
  const clean = stripHtml(value);
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

// ---------------------------------------------------------------------------
// Deterministic draft (no AI) — the fail-closed fallback
// ---------------------------------------------------------------------------

export function pickColorScheme(
  signals: ExtractedSiteSignals
): StorefrontColorScheme {
  const themeColor = signals.themeColor
    ? normalizeHexColor(signals.themeColor)
    : null;

  const normalized = signals.colors
    .map((c) => normalizeHexColor(c))
    .filter((c): c is string => !!c);

  const brand: string[] = [];
  for (const c of [themeColor, ...normalized]) {
    if (c && isBrandColor(c) && !brand.includes(c)) brand.push(c);
  }

  const primary = brand[0] ?? "#111111";
  const accent = brand.find((c) => c !== primary) ?? primary;
  const secondary = brand.find((c) => c !== primary && c !== accent) ?? accent;

  // Prefer an extracted very-light color as the background; else white.
  const light = normalized.find((c) => relativeLuminance(c) > 0.93);

  return {
    primary,
    secondary,
    accent,
    background: light ?? "#ffffff",
    text: "#1a1a1a",
  };
}

function buildHeroSection(signals: ExtractedSiteSignals): StorefrontSection {
  return {
    id: "imported-hero",
    type: "hero",
    enabled: true,
    heading: capText(signals.siteName || signals.title, 80) || "Welcome",
    subheading: capText(signals.description, 160) || undefined,
    image: signals.ogImage || undefined,
    ctaText: "Shop now",
    ctaLink: "#products",
  };
}

function buildAboutSection(
  signals: ExtractedSiteSignals
): StorefrontSection | null {
  const body = capText(signals.aboutText || signals.description, 800);
  if (!body) return null;
  return {
    id: "imported-about",
    type: "about",
    enabled: true,
    heading: "About us",
    body,
    imagePosition: "right",
  };
}

export function buildExtractionDraft(
  signals: ExtractedSiteSignals
): ImportedStoreDesign {
  const colorScheme = pickColorScheme(signals);

  const fontHeading =
    signals.fonts.map(mapToAllowedFont).find((f): f is string => !!f) ??
    undefined;
  const fontBody =
    signals.fonts
      .map(mapToAllowedFont)
      .filter((f): f is string => !!f)
      .find((f) => f !== fontHeading) ?? fontHeading;

  const sections: StorefrontSection[] = [buildHeroSection(signals)];
  const about = buildAboutSection(signals);
  if (about) sections.push(about);

  const navColors: StorefrontNavColors = {
    background: colorScheme.background,
    text: colorScheme.text,
    accent: colorScheme.primary,
  };
  const footerColors: StorefrontFooterColors = {
    background: colorScheme.primary,
    text: contrastText(colorScheme.primary),
    accent: colorScheme.accent,
  };

  const seoMeta: StorefrontSeoMeta = {
    metaTitle: capText(signals.siteName || signals.title, 70) || undefined,
    metaDescription: capText(signals.description, 160) || undefined,
    ogImage: signals.ogImage || undefined,
  };

  return {
    sourceUrl: signals.url,
    name: capText(signals.siteName || signals.title, 80) || undefined,
    about: capText(signals.aboutText || signals.description, 800) || undefined,
    logoUrl: signals.logoUrl || signals.faviconUrl || undefined,
    bannerUrl: signals.ogImage || undefined,
    storefront: {
      colorScheme,
      navColors,
      footerColors,
      fontHeading,
      fontBody,
      landingPageStyle: "hero",
      sections,
      footer:
        signals.socialLinks.length > 0
          ? { socialLinks: signals.socialLinks }
          : undefined,
      seoMeta,
    },
    aiApplied: false,
    warnings: [],
  };
}
