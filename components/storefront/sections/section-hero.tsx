import { StorefrontSection, StorefrontColorScheme } from "@/utils/types/types";
import { sanitizeUrl } from "@braintree/sanitize-url";
import FormattedText from "../formatted-text";
import { sanitizeStorefrontSectionLink } from "@/utils/storefront-links";

interface SectionHeroProps {
  section: StorefrontSection;
  colors: StorefrontColorScheme;
  shopName: string;
  shopPicture?: string;
}

// Only let recognizable CSS color tokens (hex / rgb(a) / hsl(a) / named) flow
// into inline styles. Seller-supplied colors come from a native color picker but
// the field also accepts free text and MCP input, so a malformed value falls
// back to the theme default instead of producing broken CSS.
const CSS_COLOR_RE =
  /^(#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(rgb|rgba|hsl|hsla)\([0-9.,%\s/]+\)|[a-z]+)$/i;

const safeColor = (value?: string): string | undefined => {
  const trimmed = value?.trim();
  return trimmed && CSS_COLOR_RE.test(trimmed) ? trimmed : undefined;
};

export default function SectionHero({
  section,
  colors,
  shopName,
  shopPicture,
}: SectionHeroProps) {
  const overlayOpacity = section.overlayOpacity ?? 0.6;
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

  return (
    <div
      className="relative overflow-hidden"
      style={{ backgroundColor: colors.secondary }}
    >
      {section.image && (
        <div className="absolute inset-0">
          <img
            src={sanitizeUrl(section.image)}
            alt=""
            className="h-full w-full object-cover"
            style={{ opacity: 1 - overlayOpacity }}
            fetchPriority="high"
            loading="eager"
            decoding="async"
          />
          <div
            className="absolute inset-0"
            style={{
              background: `linear-gradient(to bottom, ${
                colors.secondary
              }${Math.round(overlayOpacity * 255)
                .toString(16)
                .padStart(2, "0")}, ${colors.secondary})`,
            }}
          />
        </div>
      )}

      <div className="relative mx-auto flex max-w-6xl flex-col items-center px-6 pt-28 pb-12 text-center md:pt-32 md:pb-16">
        {shopPicture && (
          <img
            src={sanitizeUrl(shopPicture)}
            alt={shopName}
            className="mb-6 h-24 w-24 rounded-full border-4 object-cover shadow-lg md:h-32 md:w-32"
            style={{ borderColor: colors.primary }}
            fetchPriority="high"
          />
        )}

        <FormattedText
          text={section.heading || shopName}
          as="h1"
          className="font-heading text-4xl font-bold md:text-5xl"
          style={{ color: headingColor, ...headingOutlineStyle }}
        />

        {section.subheading && (
          <FormattedText
            text={section.subheading}
            as="p"
            className="font-body mt-4 max-w-xl text-lg"
            style={{ color: subheadingColor, ...subheadingOutlineStyle }}
          />
        )}

        {section.ctaText && (
          <a
            href={sanitizeStorefrontSectionLink(section.ctaLink)}
            className="mt-8 inline-block rounded-lg px-8 py-3 text-base font-bold transition-transform hover:-translate-y-0.5"
            style={{
              backgroundColor: colors.primary,
              color: colors.secondary,
            }}
          >
            {section.ctaText}
          </a>
        )}
      </div>
    </div>
  );
}
