import type { CSSProperties } from "react";
import type { StorefrontSection } from "@/utils/types/types";

// Only let recognizable CSS color tokens (hex / rgb(a) / hsl(a) / named) flow
// into inline styles. Seller-supplied colors come from a native color picker but
// the fields also accept free text and MCP input, so a malformed value falls
// back to the theme default instead of producing broken CSS.
export const CSS_COLOR_RE =
  /^(#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(rgb|rgba|hsl|hsla)\([0-9.,%\s/]+\)|[a-z]+)$/i;

export const safeCssColor = (value?: string): string | undefined => {
  const trimmed = value?.trim();
  return trimmed && CSS_COLOR_RE.test(trimmed) ? trimmed : undefined;
};

// Full-width color band for a section. Returns undefined when the section has
// no (valid) custom colors so legacy sections render byte-identical markup.
// Setting --sf-text alongside `color` re-points headings that explicitly use
// var(--sf-text) at the custom text color too.
export function sectionBandStyle(
  section: StorefrontSection
): CSSProperties | undefined {
  const backgroundColor = safeCssColor(section.backgroundColor);
  const textColor = safeCssColor(section.textColor);
  if (!backgroundColor && !textColor) return undefined;
  const style: CSSProperties = {};
  if (backgroundColor) style.backgroundColor = backgroundColor;
  if (textColor) {
    style.color = textColor;
    (style as Record<string, string>)["--sf-text"] = textColor;
  }
  return style;
}

export type SectionContentWidth = "narrow" | "normal" | "full";

// Resolve the effective content width for a section. contentWidth wins over the
// legacy boolean fullWidth; absent both, the caller's historical default holds.
export function resolveContentWidth(
  section: StorefrontSection,
  fallback: SectionContentWidth
): SectionContentWidth {
  if (section.contentWidth) return section.contentWidth;
  if (section.fullWidth === true) return "full";
  return fallback;
}

export const CONTENT_WIDTH_CLASSES: Record<SectionContentWidth, string> = {
  narrow: "mx-auto max-w-4xl px-4 py-16 md:px-6",
  normal: "mx-auto max-w-6xl px-4 py-16 md:px-6",
  full: "",
};

export const TEXT_ALIGN_CLASSES: Record<string, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

export function textAlignClass(section: StorefrontSection): string {
  return (section.textAlign && TEXT_ALIGN_CLASSES[section.textAlign]) || "";
}

// Fixed banner heights for image/banner_carousel sections. "auto" (intrinsic
// aspect ratio) is handled by the renderers themselves.
export const BANNER_HEIGHT_CLASSES: Record<
  "short" | "medium" | "tall",
  string
> = {
  short: "h-[200px] md:h-[300px]",
  medium: "h-[320px] md:h-[460px]",
  tall: "h-[440px] md:h-[600px]",
};

export function imageFitClass(section: StorefrontSection): string {
  return section.imageFit === "contain" ? "object-contain" : "object-cover";
}
