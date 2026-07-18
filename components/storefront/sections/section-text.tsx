import { StorefrontSection, StorefrontColorScheme } from "@/utils/types/types";
import FormattedText from "../formatted-text";
import {
  CONTENT_WIDTH_CLASSES,
  resolveContentWidth,
  textAlignClass,
} from "./section-style";
import SectionElementFlow, {
  headingSizeClass,
  bodySizeClass,
} from "./section-elements";

interface SectionTextProps {
  section: StorefrontSection;
  colors: StorefrontColorScheme;
}

export default function SectionText({ section, colors }: SectionTextProps) {
  const width = resolveContentWidth(section, "narrow");
  const align = textAlignClass(section);
  return (
    <div
      className={`${
        width === "full" ? "px-4 py-16 md:px-6" : CONTENT_WIDTH_CLASSES[width]
      } ${align}`.trim()}
    >
      <SectionElementFlow
        section={section}
        colors={colors}
        slots={{
          heading: section.heading && (
            <FormattedText
              text={section.heading}
              as="h2"
              className={`font-heading mb-6 ${headingSizeClass(
                section,
                "text-3xl"
              )} font-bold`}
              style={{ color: "var(--sf-text)" }}
            />
          ),
          body: section.body && (
            <FormattedText
              text={section.body}
              as="div"
              className={`font-body ${bodySizeClass(
                section,
                "text-lg"
              )} leading-relaxed whitespace-pre-line opacity-80`}
            />
          ),
        }}
      />
    </div>
  );
}
