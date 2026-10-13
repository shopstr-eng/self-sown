import type {
  StorefrontColorScheme,
  StorefrontProductPageConfig,
  StorefrontSection,
} from "./storefront";

// Shared contract for the per-product page customization stored in the
// "page_config" tag on a kind:30402 listing event. The web modal
// (components/customize-product-page-modal.tsx) and the mobile listing
// design screens both build, validate, parse, and serialize through these
// helpers so the two platforms can never disagree about the payload.

// Adding a StorefrontProductPageConfig field is a compile error here until
// the field is listed — the parity test then fails until BOTH editors
// (web modal + mobile hub screen) reference it.
type ExhaustiveFieldList<T, L extends readonly (keyof T)[]> =
  Exclude<keyof T, L[number]> extends never ? L : never;

const productPageConfigFields = [
  "sections",
  "themeOverrides",
  "ogImage",
  "metaTitle",
  "metaDescription",
] as const satisfies readonly (keyof StorefrontProductPageConfig)[];

export const PRODUCT_PAGE_CONFIG_FIELDS: ExhaustiveFieldList<
  StorefrontProductPageConfig,
  typeof productPageConfigFields
> = productPageConfigFields;

export const PRODUCT_PAGE_META_TITLE_MAX = 200;
export const PRODUCT_PAGE_META_DESCRIPTION_MAX = 500;
export const PRODUCT_PAGE_CONFIG_MAX_BYTES = 64 * 1024;

const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const URL_VALUE_RE = /^(https?:\/\/|data:image\/|\/)[^\s]+$/i;

export function isProductPageConfigHexColor(value: string): boolean {
  return HEX_COLOR_RE.test(value);
}

export function isProductPageConfigUrl(value: string): boolean {
  return URL_VALUE_RE.test(value);
}

export interface ProductPageConfigInput {
  sections: StorefrontSection[];
  useShopDefaults: boolean;
  themeOverrides: Partial<StorefrontColorScheme>;
  metaTitle: string;
  metaDescription: string;
  ogImage: string;
}

// Single source of truth for "what gets persisted": shop-defaults mode omits
// sections, empty strings/records are dropped, and a fully empty result
// collapses to null — which removes the page_config tag entirely so the
// product inherits the shop-wide product page.
export function buildProductPageConfig(
  input: ProductPageConfigInput
): StorefrontProductPageConfig | null {
  const cfg: StorefrontProductPageConfig = {};
  if (!input.useShopDefaults) cfg.sections = input.sections;
  if (Object.keys(input.themeOverrides).length > 0) {
    cfg.themeOverrides = input.themeOverrides;
  }
  if (input.metaTitle.trim()) cfg.metaTitle = input.metaTitle.trim();
  if (input.metaDescription.trim()) {
    cfg.metaDescription = input.metaDescription.trim();
  }
  if (input.ogImage.trim()) cfg.ogImage = input.ogImage.trim();
  if (
    !cfg.sections &&
    !cfg.themeOverrides &&
    !cfg.metaTitle &&
    !cfg.metaDescription &&
    !cfg.ogImage
  ) {
    return null;
  }
  return cfg;
}

export function validateProductPageConfig(
  config: StorefrontProductPageConfig | null
): string | null {
  if (!config) return null;
  for (const [key, val] of Object.entries(config.themeOverrides ?? {})) {
    if (val && !isProductPageConfigHexColor(val)) {
      return `Color "${key}" must be a valid hex value (e.g. #1A2B3C).`;
    }
  }
  if (config.ogImage && !isProductPageConfigUrl(config.ogImage)) {
    return "OG image must be a valid URL.";
  }
  if ((config.metaTitle ?? "").length > PRODUCT_PAGE_META_TITLE_MAX) {
    return `Meta title is too long (${PRODUCT_PAGE_META_TITLE_MAX} char max).`;
  }
  if (
    (config.metaDescription ?? "").length > PRODUCT_PAGE_META_DESCRIPTION_MAX
  ) {
    return `Meta description is too long (${PRODUCT_PAGE_META_DESCRIPTION_MAX} char max).`;
  }
  for (const [index, section] of (config.sections ?? []).entries()) {
    if (section.type === "product_gallery" && section.galleryImages) {
      for (const url of section.galleryImages) {
        if (url && !isProductPageConfigUrl(url)) {
          return `Section ${index + 1} (Gallery) has an invalid image URL: "${url.slice(0, 60)}".`;
        }
      }
    }
    if (
      section.type === "image" &&
      section.image &&
      !isProductPageConfigUrl(section.image)
    ) {
      return `Section ${index + 1} (Image) has an invalid image URL.`;
    }
    if (
      section.type === "product_specifications" &&
      section.specifications
    ) {
      for (const spec of section.specifications) {
        if (!spec.label.trim() || !spec.value.trim()) {
          return `Section ${index + 1} (Specifications) has an empty label or value.`;
        }
      }
    }
  }
  const serialized = JSON.stringify(config);
  let size: number;
  try {
    // TextEncoder counts UTF-8 bytes (the relay-side limit); Hermes may lack
    // it, so fall back to the string length.
    size = new TextEncoder().encode(serialized).length;
  } catch {
    size = serialized.length;
  }
  if (size > PRODUCT_PAGE_CONFIG_MAX_BYTES) {
    return `Customization is too large (${(size / 1024).toFixed(
      1
    )} KB). Maximum is ${
      PRODUCT_PAGE_CONFIG_MAX_BYTES / 1024
    } KB. Reduce gallery images, spec entries, or text length.`;
  }
  return null;
}

export function parseProductPageConfigJson(
  raw: string
): StorefrontProductPageConfig | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    // Deliberately shallow: renderers tolerate raw configs (the web reader
    // historically cast JSON.parse output), so parse must not drop fields.
    return value as StorefrontProductPageConfig;
  } catch {
    return undefined;
  }
}

export function parseProductPageConfig(
  tags: string[][]
): StorefrontProductPageConfig | undefined {
  // Last tag wins, mirroring the web parser's assignment loop.
  const raw = tags.filter((tag) => tag[0] === "page_config").pop()?.[1];
  return raw ? parseProductPageConfigJson(raw) : undefined;
}

export function withProductPageConfig(
  tags: string[][],
  config: StorefrontProductPageConfig | null | undefined
): string[][] {
  const rest = tags.filter((tag) => tag[0] !== "page_config");
  if (config) rest.push(["page_config", JSON.stringify(config)]);
  return rest;
}
