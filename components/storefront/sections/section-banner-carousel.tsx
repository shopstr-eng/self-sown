"use client";

import { useCallback, useEffect, useState } from "react";
import { StorefrontSection, StorefrontColorScheme } from "@/utils/types/types";
import { sanitizeUrl } from "@braintree/sanitize-url";
import FormattedText from "../formatted-text";
import { sanitizeStorefrontSectionLink } from "@/utils/storefront-links";

interface SectionBannerCarouselProps {
  section: StorefrontSection;
  colors: StorefrontColorScheme;
}

// Only let recognizable CSS color tokens flow into inline styles (same guard the
// hero section uses); a malformed seller/MCP value falls back to the theme.
const CSS_COLOR_RE =
  /^(#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(rgb|rgba|hsl|hsla)\([0-9.,%\s/]+\)|[a-z]+)$/i;

const safeColor = (value?: string): string | undefined => {
  const trimmed = value?.trim();
  return trimmed && CSS_COLOR_RE.test(trimmed) ? trimmed : undefined;
};

const MIN_INTERVAL_MS = 1500;
const DEFAULT_INTERVAL_MS = 5000;

export default function SectionBannerCarousel({
  section,
  colors,
}: SectionBannerCarouselProps) {
  const slides = (section.bannerSlides || []).filter(
    (slide) => slide && typeof slide.image === "string" && slide.image.trim()
  );
  const count = slides.length;
  const [current, setCurrent] = useState(0);

  // Keep the active index in range if the slide set shrinks (editor live edits).
  useEffect(() => {
    setCurrent((prev) => (prev > count - 1 ? Math.max(count - 1, 0) : prev));
  }, [count]);

  const goTo = useCallback(
    (index: number) => {
      if (count === 0) return;
      setCurrent(((index % count) + count) % count);
    },
    [count]
  );

  const autoplay = section.bannerAutoplay === true && count > 1;
  const intervalMs = Math.max(
    MIN_INTERVAL_MS,
    typeof section.bannerInterval === "number" && section.bannerInterval > 0
      ? section.bannerInterval
      : DEFAULT_INTERVAL_MS
  );

  useEffect(() => {
    if (!autoplay) return;
    const timer = setInterval(() => {
      setCurrent((prev) => (prev + 1) % count);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [autoplay, intervalMs, count]);

  if (count === 0) return null;

  const overlayOpacity = section.overlayOpacity ?? 0.4;
  const headingColor = safeColor(section.headingColor) || colors.background;
  const subheadingColor =
    safeColor(section.subheadingColor) || colors.background + "CC";
  const outlineColor = safeColor(section.textOutlineColor);
  const headingOutlineStyle = outlineColor
    ? {
        textShadow: `-2px -2px 0 ${outlineColor}, 2px -2px 0 ${outlineColor}, -2px 2px 0 ${outlineColor}, 2px 2px 0 ${outlineColor}, 0 0 3px ${outlineColor}`,
      }
    : {};
  const subheadingOutlineStyle = outlineColor
    ? {
        textShadow: `-1px -1px 0 ${outlineColor}, 1px -1px 0 ${outlineColor}, -1px 1px 0 ${outlineColor}, 1px 1px 0 ${outlineColor}`,
      }
    : {};

  const isFullWidth = section.fullWidth === true;

  return (
    <div className={isFullWidth ? "" : "mx-auto max-w-6xl px-4 py-16 md:px-6"}>
      <div
        className={`relative w-full overflow-hidden ${
          isFullWidth ? "" : "rounded-2xl border-2 shadow-lg"
        }`}
        style={isFullWidth ? undefined : { borderColor: colors.primary }}
        aria-roledescription="carousel"
      >
        <div className="relative h-[320px] w-full md:h-[460px]">
          {slides.map((slide, idx) => {
            const isActive = idx === current;
            const ctaHref = slide.ctaText
              ? sanitizeStorefrontSectionLink(slide.ctaLink)
              : undefined;
            const hasOverlayText =
              slide.heading || slide.subheading || slide.ctaText;
            return (
              <div
                key={idx}
                className={`absolute inset-0 transition-opacity duration-700 ${
                  isActive ? "opacity-100" : "pointer-events-none opacity-0"
                }`}
                aria-hidden={!isActive}
              >
                <img
                  src={sanitizeUrl(slide.image)}
                  alt={slide.heading || ""}
                  className="h-full w-full object-cover"
                  loading={idx === 0 ? "eager" : "lazy"}
                  decoding="async"
                />
                {hasOverlayText && (
                  <>
                    <div
                      className="absolute inset-0"
                      style={{
                        backgroundColor: `rgba(0,0,0,${overlayOpacity})`,
                      }}
                    />
                    <div className="absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
                      {slide.heading && (
                        <FormattedText
                          text={slide.heading}
                          as="h2"
                          className="font-heading text-3xl font-bold md:text-5xl"
                          style={{
                            color: headingColor,
                            ...headingOutlineStyle,
                          }}
                        />
                      )}
                      {slide.subheading && (
                        <FormattedText
                          text={slide.subheading}
                          as="p"
                          className="font-body mt-3 max-w-xl text-lg"
                          style={{
                            color: subheadingColor,
                            ...subheadingOutlineStyle,
                          }}
                        />
                      )}
                      {slide.ctaText && ctaHref && (
                        <a
                          href={ctaHref}
                          className="mt-6 inline-block rounded-lg px-8 py-3 text-base font-bold transition-transform hover:-translate-y-0.5"
                          style={{
                            backgroundColor: colors.primary,
                            color: colors.secondary,
                          }}
                        >
                          {slide.ctaText}
                        </a>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>

        {count > 1 && (
          <>
            <button
              type="button"
              onClick={() => goTo(current - 1)}
              aria-label="Previous slide"
              className="absolute top-1/2 left-3 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full text-xl font-bold shadow-md transition hover:scale-110"
              style={{ backgroundColor: colors.background, color: colors.text }}
            >
              ‹
            </button>
            <button
              type="button"
              onClick={() => goTo(current + 1)}
              aria-label="Next slide"
              className="absolute top-1/2 right-3 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full text-xl font-bold shadow-md transition hover:scale-110"
              style={{ backgroundColor: colors.background, color: colors.text }}
            >
              ›
            </button>

            <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 gap-2">
              {slides.map((_, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => goTo(idx)}
                  aria-label={`Go to slide ${idx + 1}`}
                  className="h-2.5 w-2.5 rounded-full transition"
                  style={{
                    backgroundColor:
                      idx === current
                        ? colors.primary
                        : colors.background + "99",
                  }}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
