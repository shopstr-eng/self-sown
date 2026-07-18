import { StorefrontSection, StorefrontColorScheme } from "@/utils/types/types";
import { sanitizeUrl } from "@braintree/sanitize-url";
import FormattedText from "../formatted-text";
import { sanitizeStorefrontSectionLink } from "@/utils/storefront-links";
import { safeCssColor as safeColor } from "./section-style";
import SectionElementFlow, {
  SectionButtons,
  headingSizeClass,
  bodySizeClass,
} from "./section-elements";

interface SectionHeroProps {
  section: StorefrontSection;
  colors: StorefrontColorScheme;
  shopName: string;
  shopPicture?: string;
}

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

        <SectionElementFlow
          section={section}
          colors={colors}
          slots={{
            heading: (
              <FormattedText
                text={section.heading || shopName}
                as="h1"
                className={`font-heading ${headingSizeClass(
                  section,
                  "text-4xl"
                )} font-bold${section.headingSize ? "" : "md:text-5xl"}`}
                style={{ color: headingColor, ...headingOutlineStyle }}
              />
            ),
            subheading: section.subheading && (
              <FormattedText
                text={section.subheading}
                as="p"
                className={`font-body mt-4 max-w-xl ${bodySizeClass(
                  section,
                  "text-lg"
                )}`}
                style={{ color: subheadingColor, ...subheadingOutlineStyle }}
              />
            ),
            buttons:
              section.ctaText || section.buttons?.length ? (
                <>
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
                  <SectionButtons section={section} colors={colors} />
                </>
              ) : undefined,
          }}
        />
      </div>
    </div>
  );
}
