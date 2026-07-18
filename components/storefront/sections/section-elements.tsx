import { Fragment, ReactNode, CSSProperties } from "react";
import { StorefrontSection, StorefrontColorScheme } from "@/utils/types/types";
import {
  resolveSectionElements,
  StorefrontSectionElement,
} from "@milk-market/domain";
import { sanitizeUrl } from "@braintree/sanitize-url";
import { sanitizeStorefrontSectionLink } from "@/utils/storefront-links";

// Element-level layout helpers shared by every section renderer that supports
// arranging (see STOREFRONT_SECTION_ELEMENTS in the domain package). Sections
// keep their bespoke markup by passing it in as slots; this module only
// orchestrates order, image placement, sizes and the shared buttons row.
// When a section carries none of the new layout fields the flow renders the
// slots in their historical default order inside plain fragments, so legacy
// configs produce identical DOM.

const HEADING_SIZE_CLASSES: Record<string, string> = {
  sm: "text-xl md:text-2xl",
  md: "text-2xl md:text-3xl",
  lg: "text-3xl md:text-4xl",
  xl: "text-4xl md:text-5xl",
};

const BODY_SIZE_CLASSES: Record<string, string> = {
  sm: "text-base",
  md: "text-lg",
  lg: "text-xl",
  xl: "text-2xl",
};

// Size class for the section heading; the fallback is the section's historical
// class so unset headingSize renders byte-identical legacy markup.
export function headingSizeClass(
  section: StorefrontSection,
  fallback: string
): string {
  return (
    (section.headingSize && HEADING_SIZE_CLASSES[section.headingSize]) ||
    fallback
  );
}

export function bodySizeClass(
  section: StorefrontSection,
  fallback: string
): string {
  return (section.bodySize && BODY_SIZE_CLASSES[section.bodySize]) || fallback;
}

// Static class map (Tailwind can't compile dynamic widths); keys mirror the
// sanitizer's IMAGE_WIDTHS allowlist. Width applies from md up — mobile always
// gets the full width.
const IMAGE_WIDTH_CLASSES: Record<number, string> = {
  25: "md:w-1/4",
  33: "md:w-1/3",
  50: "md:w-1/2",
  66: "md:w-2/3",
  75: "md:w-3/4",
  100: "md:w-full",
};

const BUTTON_SIZE_CLASSES: Record<string, string> = {
  sm: "px-4 py-2 text-sm",
  md: "px-6 py-2.5 text-base",
  lg: "px-8 py-3 text-lg",
};

const ALIGN_JUSTIFY_CLASSES: Record<string, string> = {
  left: "justify-start",
  center: "justify-center",
  right: "justify-end",
};

// sRGB luminance (0..1) of a #rrggbb color, or null when unparseable.
// Mirrors the heuristic used by the email templates.
function hexLuminance(hex: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return (
    (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) /
    255
  );
}

// White or near-black, whichever reads better on the given hex color.
function readableTextOn(hex: string): string {
  const lum = hexLuminance(hex);
  return lum !== null && lum > 0.6 ? "#111827" : "#ffffff";
}

// The theme's preferred label color, unless it's too close in luminance to
// the button background (e.g. yellow-on-yellow palettes) — then fall back to
// white/near-black so the label stays readable.
function buttonLabelColor(bg: string, preferred: string): string {
  const bgLum = hexLuminance(bg);
  const prefLum = hexLuminance(preferred);
  if (bgLum === null || prefLum === null) return readableTextOn(bg);
  return Math.abs(bgLum - prefLum) >= 0.3 ? preferred : readableTextOn(bg);
}

function buttonStyle(
  variant: string | undefined,
  colors: StorefrontColorScheme,
  surface?: string
): CSSProperties {
  if (variant === "secondary") {
    return {
      backgroundColor: colors.secondary,
      color: buttonLabelColor(colors.secondary, colors.background),
    };
  }
  if (variant === "outline") {
    // Outline buttons sit directly on the surface behind them (the page
    // background, or the overlay color under background image placement), so
    // their border/label must contrast with THAT surface.
    const accent = buttonLabelColor(
      surface ?? colors.background,
      colors.primary
    );
    return {
      border: `2px solid ${accent}`,
      color: accent,
      backgroundColor: "transparent",
    };
  }
  // primary (default) mirrors the hero CTA styling, with a readability
  // fallback when primary and secondary are too close in luminance.
  return {
    backgroundColor: colors.primary,
    color: buttonLabelColor(colors.primary, colors.secondary),
  };
}

// Renders the section's buttons row(s). Consecutive buttons with the same
// alignment share a flex row; a differently-aligned button starts a new row.
// Hrefs are sanitized (http(s)/relative/# only) — storefront events are
// permissionless and per-product pageConfig bypasses the domain sanitizer.
export function SectionButtons({
  section,
  colors,
  surface,
}: {
  section: StorefrontSection;
  colors: StorefrontColorScheme;
  // Color of the surface behind the buttons when it isn't the theme
  // background (e.g. the overlay under background image placement).
  surface?: string;
}) {
  const buttons = (section.buttons || []).filter(
    (btn) => btn && typeof btn.label === "string" && btn.label
  );
  if (buttons.length === 0) return null;

  const rows: { align: string; items: typeof buttons }[] = [];
  for (const btn of buttons) {
    const align = btn.align || section.textAlign || "left";
    const last = rows[rows.length - 1];
    if (last && last.align === align) last.items.push(btn);
    else rows.push({ align, items: [btn] });
  }

  return (
    <div className="mt-8 space-y-3">
      {rows.map((row, rowIdx) => (
        <div
          key={rowIdx}
          className={`flex flex-wrap gap-3 ${
            ALIGN_JUSTIFY_CLASSES[row.align] || "justify-start"
          }`}
        >
          {row.items.map((btn, idx) => (
            <a
              key={idx}
              href={sanitizeStorefrontSectionLink(btn.href)}
              className={`font-heading inline-block rounded-lg font-bold transition-transform hover:-translate-y-0.5 ${
                BUTTON_SIZE_CLASSES[btn.size || "md"] || BUTTON_SIZE_CLASSES.md
              }`}
              style={buttonStyle(btn.variant, colors, surface)}
            >
              {btn.label}
            </a>
          ))}
        </div>
      ))}
    </div>
  );
}

export type SectionElementSlots = Partial<
  Record<StorefrontSectionElement, ReactNode>
>;

// True when the section carries fields that change the structural layout (as
// opposed to size/button fields that sections can apply in-place). Sections
// with a bespoke legacy structure (about) keep it unless this returns true.
export function hasStructuralLayout(section: StorefrontSection): boolean {
  return Boolean(
    (section.elementOrder && section.elementOrder.length > 0) ||
    section.imagePlacement ||
    section.imageWidth
  );
}

// Renders the section's slots in the resolved element order, honoring
// imagePlacement (left/right two-column, top/bottom pinning, background) and
// imageWidth. Slots that are null/undefined are skipped; the "buttons" slot
// defaults to <SectionButtons> unless the caller overrides it.
export default function SectionElementFlow({
  section,
  colors,
  slots,
}: {
  section: StorefrontSection;
  colors: StorefrontColorScheme;
  slots: SectionElementSlots;
}) {
  const order = resolveSectionElements(section);
  const nodes = new Map<StorefrontSectionElement, ReactNode>();
  for (const el of order) {
    if (el === "buttons") {
      const node =
        slots.buttons !== undefined ? (
          slots.buttons
        ) : (
          <SectionButtons
            section={section}
            colors={colors}
            surface={
              section.imagePlacement === "background" && section.image
                ? colors.secondary
                : undefined
            }
          />
        );
      if (node && (slots.buttons !== undefined || section.buttons?.length)) {
        nodes.set("buttons", node);
      }
    } else if (slots[el]) {
      nodes.set(el, slots[el]);
    }
  }

  const placement = section.imagePlacement;
  const hasImage = nodes.has("image");
  const widthClass = section.imageWidth
    ? IMAGE_WIDTH_CLASSES[section.imageWidth]
    : undefined;
  const others = [...nodes.keys()].filter((k) => k !== "image");

  if (
    hasImage &&
    (placement === "left" || placement === "right") &&
    others.length > 0
  ) {
    return (
      <div
        className={`flex flex-col gap-8 md:items-center ${
          placement === "left" ? "md:flex-row-reverse" : "md:flex-row"
        }`}
      >
        <div className="min-w-0 flex-1">
          {others.map((k) => (
            <Fragment key={k}>{nodes.get(k)}</Fragment>
          ))}
        </div>
        <div
          className={
            widthClass
              ? `w-full shrink-0 ${widthClass}`
              : "w-full min-w-0 md:flex-1"
          }
        >
          {nodes.get("image")}
        </div>
      </div>
    );
  }

  if (hasImage && placement === "background" && section.image) {
    const overlayOpacity = section.overlayOpacity ?? 0.6;
    const overlayText = readableTextOn(colors.secondary);
    return (
      <div className="relative overflow-hidden rounded-xl">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={sanitizeUrl(section.image)}
          alt=""
          aria-hidden="true"
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div
          className="absolute inset-0"
          style={{
            backgroundColor: colors.secondary,
            opacity: overlayOpacity,
          }}
        />
        <div
          className="relative px-6 py-12"
          // Text over the overlay must contrast with the OVERLAY color, not
          // the theme background — on light themes the theme text color is
          // dark and vanishes against the dark overlay. Headings read
          // --sf-text, so override the variable too.
          style={
            {
              color: overlayText,
              "--sf-text": overlayText,
            } as CSSProperties
          }
        >
          {others.map((k) => (
            <Fragment key={k}>{nodes.get(k)}</Fragment>
          ))}
        </div>
      </div>
    );
  }

  let keys = [...nodes.keys()];
  if (hasImage && placement === "top") {
    keys = ["image", ...keys.filter((k) => k !== "image")];
  } else if (hasImage && placement === "bottom") {
    keys = [...keys.filter((k) => k !== "image"), "image"];
  }

  return (
    <>
      {keys.map((k) =>
        k === "image" && widthClass ? (
          <div key={k} className={`mx-auto w-full ${widthClass}`}>
            {nodes.get(k)}
          </div>
        ) : (
          <Fragment key={k}>{nodes.get(k)}</Fragment>
        )
      )}
    </>
  );
}
