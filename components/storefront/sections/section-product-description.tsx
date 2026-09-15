import { StorefrontSection, StorefrontColorScheme } from "@/utils/types/types";
import { ProductData } from "@/utils/parsers/product-parser-functions";
import FormattedText from "../formatted-text";
import SectionElementFlow, {
  headingClassName,
  bodyClassName,
} from "./section-elements";

interface Props {
  section: StorefrontSection;
  colors: StorefrontColorScheme;
  product: ProductData;
}

export default function SectionProductDescription({
  section,
  colors,
  product,
}: Props) {
  const heading = section.heading || "About this product";
  const body = section.body || product.summary;
  if (!body) return null;
  return (
    <div className="mx-auto max-w-4xl px-4 py-12 md:px-6">
      <SectionElementFlow
        section={section}
        colors={colors}
        slots={{
          heading: (
            <h2
              className={`font-heading mb-4 ${headingClassName(
                section,
                "text-2xl",
                "md:text-3xl"
              )}`}
              style={{ color: colors.text }}
            >
              {heading}
            </h2>
          ),
          content: (
            <FormattedText
              text={body}
              as="div"
              className={`font-body ${bodyClassName(
                section,
                "text-base",
                "md:text-lg"
              )} leading-relaxed whitespace-pre-line opacity-80`}
            />
          ),
        }}
      />
    </div>
  );
}
