"use client";

import { StorefrontSection, StorefrontColorScheme } from "@/utils/types/types";
import { sanitizeUrl } from "@braintree/sanitize-url";

interface SectionMarqueeProps {
  section: StorefrontSection;
  colors: StorefrontColorScheme;
  shopName: string;
}

// Only let recognizable CSS color tokens flow into inline styles (same guard the
// hero/banner sections use); a malformed seller/MCP value falls back to theme.
const CSS_COLOR_RE =
  /^(#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(rgb|rgba|hsl|hsla)\([0-9.,%\s/]+\)|[a-z]+)$/i;

const safeColor = (value?: string): string | undefined => {
  const trimmed = value?.trim();
  return trimmed && CSS_COLOR_RE.test(trimmed) ? trimmed : undefined;
};

const DEFAULT_SPEED_SECONDS = 20;
const MIN_SPEED_SECONDS = 5;
const MAX_SPEED_SECONDS = 120;

// Each group repeats the unit enough times to overflow wide viewports so the
// duplicated (translateX -50%) loop never shows an empty gap.
const REPEAT = 12;

export default function SectionMarquee({
  section,
  colors,
  shopName,
}: SectionMarqueeProps) {
  const text = (section.heading || "").trim() || (shopName || "").trim();
  const logo = section.image?.trim() ? sanitizeUrl(section.image.trim()) : "";

  // Nothing to show — don't render an empty strip.
  if (!text && (!logo || logo === "about:blank")) return null;

  const background =
    safeColor(section.marqueeBackgroundColor) || colors.primary;
  const textColor = safeColor(section.headingColor) || colors.secondary;

  const speed =
    typeof section.marqueeSpeed === "number" && section.marqueeSpeed > 0
      ? Math.min(
          Math.max(section.marqueeSpeed, MIN_SPEED_SECONDS),
          MAX_SPEED_SECONDS
        )
      : DEFAULT_SPEED_SECONDS;
  const reverse = section.marqueeDirection === "right";

  const renderGroup = (groupKey: number) => (
    // Both groups are decorative duplication for the seamless loop; the visible
    // text is announced once via the container's aria-label, so hide the repeats.
    <div className="flex shrink-0 items-center" aria-hidden="true">
      {Array.from({ length: REPEAT }).map((_, i) => (
        <div
          key={`${groupKey}-${i}`}
          className="flex shrink-0 items-center gap-3 px-6"
        >
          {logo && logo !== "about:blank" ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logo}
              alt=""
              className="h-7 w-auto object-contain md:h-9"
              loading="lazy"
            />
          ) : null}
          {text ? (
            <span className="font-heading text-lg font-bold tracking-wide whitespace-nowrap uppercase md:text-2xl">
              {text}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );

  return (
    <div
      className="w-full overflow-hidden py-3 md:py-4"
      style={{ backgroundColor: background, color: textColor }}
      role="marquee"
      aria-label={text || "Banner"}
    >
      <div
        className="sf-marquee-track flex w-max"
        style={{
          animationDuration: `${speed}s`,
          animationDirection: reverse ? "reverse" : "normal",
        }}
      >
        {renderGroup(0)}
        {renderGroup(1)}
      </div>
      <style>{`
        .sf-marquee-track {
          animation-name: sf-marquee;
          animation-timing-function: linear;
          animation-iteration-count: infinite;
          will-change: transform;
        }
        @keyframes sf-marquee {
          from { transform: translateX(0); }
          to { transform: translateX(-50%); }
        }
        @media (prefers-reduced-motion: reduce) {
          .sf-marquee-track { animation: none; }
        }
      `}</style>
    </div>
  );
}
