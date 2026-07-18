import { StorefrontSection, StorefrontColorScheme } from "@/utils/types/types";
import { sanitizeUrl } from "@braintree/sanitize-url";
import {
  BANNER_HEIGHT_CLASSES,
  imageFitClass,
  resolveContentWidth,
} from "./section-style";
import SectionElementFlow from "./section-elements";

interface SectionImageProps {
  section: StorefrontSection;
  colors: StorefrontColorScheme;
}

export default function SectionImage({ section, colors }: SectionImageProps) {
  if (!section.image) return null;

  const width = resolveContentWidth(section, "normal");
  const isFullWidth = width === "full";
  // "auto" (default) keeps the image's intrinsic aspect ratio — the historical
  // behavior. short/medium/tall crop to a fixed banner height.
  const fixedHeight =
    section.imageHeight && section.imageHeight !== "auto"
      ? BANNER_HEIGHT_CLASSES[section.imageHeight]
      : undefined;

  return (
    <div
      className={
        isFullWidth
          ? ""
          : width === "narrow"
            ? "mx-auto max-w-4xl px-4 py-16 md:px-6"
            : "mx-auto max-w-6xl px-4 py-16 md:px-6"
      }
    >
      <SectionElementFlow
        section={section}
        colors={colors}
        slots={{
          image: (
            <figure>
              <img
                src={sanitizeUrl(section.image)}
                alt={section.caption || section.heading || ""}
                className={
                  fixedHeight
                    ? `w-full ${fixedHeight} ${imageFitClass(section)} ${
                        isFullWidth ? "" : "rounded-xl shadow-lg"
                      }`.trim()
                    : `mx-auto h-auto max-w-full ${
                        isFullWidth ? "" : "rounded-xl shadow-lg"
                      }`.trim()
                }
              />
              {section.caption && (
                <figcaption
                  className="mt-3 text-center text-sm opacity-50"
                  style={isFullWidth ? { padding: "0 1.5rem" } : {}}
                >
                  {section.caption}
                </figcaption>
              )}
            </figure>
          ),
        }}
      />
    </div>
  );
}
