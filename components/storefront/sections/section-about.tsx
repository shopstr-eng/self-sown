import { StorefrontSection, StorefrontColorScheme } from "@/utils/types/types";
import { sanitizeUrl } from "@braintree/sanitize-url";
import FormattedText from "../formatted-text";
import { textAlignClass } from "./section-style";
import SectionElementFlow, {
  SectionButtons,
  hasStructuralLayout,
  headingSizeClass,
  bodySizeClass,
} from "./section-elements";

interface SectionAboutProps {
  section: StorefrontSection;
  colors: StorefrontColorScheme;
}

// Image height cap for the about layout. "auto" removes the historical 400px
// cap so tall source images render at their intrinsic aspect ratio.
const ABOUT_IMAGE_MAX_HEIGHTS: Record<string, string | undefined> = {
  auto: undefined,
  short: "280px",
  medium: "400px",
  tall: "560px",
};

export default function SectionAbout({ section, colors }: SectionAboutProps) {
  const imagePos = section.imagePosition || "right";
  const align = textAlignClass(section);
  const maxHeight = section.imageHeight
    ? ABOUT_IMAGE_MAX_HEIGHTS[section.imageHeight]
    : "400px";

  const headingNode = section.heading && (
    <FormattedText
      text={section.heading}
      as="h2"
      className={`font-heading mb-8 ${headingSizeClass(
        section,
        "text-3xl"
      )} font-bold`}
      style={{ color: "var(--sf-text)" }}
    />
  );
  const bodyNode = section.body && (
    <FormattedText
      text={section.body}
      as="p"
      className={`font-body ${bodySizeClass(
        section,
        "text-lg"
      )} leading-relaxed whitespace-pre-line opacity-80`}
    />
  );
  const imageNode = section.image && (
    <img
      src={sanitizeUrl(section.image)}
      alt={section.heading || "About"}
      className={`w-full rounded-xl shadow-lg ${
        section.imageFit === "contain" ? "object-contain" : "object-cover"
      }`}
      style={maxHeight ? { maxHeight } : undefined}
    />
  );

  if (hasStructuralLayout(section)) {
    return (
      <div className={`mx-auto max-w-6xl px-4 py-16 md:px-6 ${align}`.trim()}>
        <SectionElementFlow
          section={section}
          colors={colors}
          slots={{
            heading: headingNode,
            body: bodyNode,
            image: imageNode,
          }}
        />
      </div>
    );
  }

  return (
    <div className={`mx-auto max-w-6xl px-4 py-16 md:px-6 ${align}`.trim()}>
      {headingNode}
      <div
        className={`flex flex-col gap-8 md:flex-row md:items-center ${
          imagePos === "left" ? "md:flex-row-reverse" : ""
        }`}
      >
        <div className="flex-1">{bodyNode}</div>
        {section.image && <div className="flex-1">{imageNode}</div>}
      </div>
      <SectionButtons section={section} colors={colors} />
    </div>
  );
}
