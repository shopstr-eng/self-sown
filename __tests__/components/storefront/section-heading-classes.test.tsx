/**
 * @jest-environment jsdom
 *
 * Regression guard for merged-together CSS class names in storefront section
 * headings. section-hero.tsx once built its heading className as
 * `font-bold${section.headingSize ? "" : "md:text-5xl"}` — missing the
 * separating space — producing the dead class `font-boldmd:text-5xl`. The
 * heading silently lost BOTH its bold weight and its responsive size.
 *
 * These tests render every section that uses the conditional
 * `font-bold` + legacy responsive-size pattern and assert on the TOKENIZED
 * class list (split on whitespace), so a merged token can never pass:
 * - headingSize unset: `font-bold` and the legacy responsive size
 *   (`md:text-5xl` hero / `md:text-3xl` product sections) are separate tokens
 * - headingSize set: the legacy responsive override is gone entirely
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import type { StorefrontSection } from "@/utils/types/types";
import type { ProductData } from "@/utils/parsers/product-parser-functions";
import SectionHero from "@/components/storefront/sections/section-hero";
import SectionProductDescription from "@/components/storefront/sections/section-product-description";
import SectionProductShippingReturns from "@/components/storefront/sections/section-product-shipping-returns";
import SectionProductGallery from "@/components/storefront/sections/section-product-gallery";
import SectionProductSpecifications from "@/components/storefront/sections/section-product-specifications";
import SectionRelatedProducts from "@/components/storefront/sections/section-related-products";

// The grid pulls in ProductCard (cart/wallet contexts); the heading under test
// is rendered before it, so stub the grid out.
jest.mock("@/components/storefront/storefront-product-grid", () => ({
  __esModule: true,
  default: () => <div data-testid="product-grid" />,
}));

const colors = {
  primary: "#111111",
  secondary: "#222222",
  accent: "#333333",
  background: "#ffffff",
  text: "#000000",
};

const product: ProductData = {
  id: "p1",
  d: "raw-milk",
  pubkey: "a".repeat(64),
  createdAt: 1700000000,
  title: "Raw Milk",
  summary: "Fresh from pastured cows.",
  publishedAt: "",
  images: ["https://example.com/milk.jpg"],
  categories: ["dairy"],
  location: "",
  price: 5,
  currency: "USD",
  totalCost: 5,
  condition: "new",
};

const otherProduct: ProductData = {
  ...product,
  id: "p2",
  d: "cheese",
  title: "Cheese",
};

function classTokens(el: HTMLElement): string[] {
  return el.className.split(/\s+/).filter(Boolean);
}

// The core assertion: every token is a standalone class. `font-bold` and the
// responsive size must be separate tokens, and no token may glue `font-bold`
// to anything else (the original `font-boldmd:text-5xl` bug).
function expectSeparateBoldAndSize(heading: HTMLElement, sizeToken: string) {
  const tokens = classTokens(heading);
  expect(tokens).toContain("font-bold");
  expect(tokens).toContain(sizeToken);
  for (const token of tokens) {
    expect(token.startsWith("font-bold")).toBe(token === "font-bold");
  }
}

// headingSize set → the size map wins; the section's legacy base/override
// tokens must not linger.
function expectNoLegacySize(
  heading: HTMLElement,
  legacyTokens: string[]
) {
  const tokens = classTokens(heading);
  expect(tokens).toContain("font-bold");
  expect(tokens).toContain("text-xl"); // headingSize "sm"
  expect(tokens).toContain("md:text-2xl"); // headingSize "sm"
  for (const legacy of legacyTokens) {
    expect(tokens).not.toContain(legacy);
  }
}

const cases: Array<{
  name: string;
  sectionType: StorefrontSection["type"];
  legacySizeToken: string;
  legacyBaseToken: string;
  render: (section: StorefrontSection) => void;
  getHeading: () => HTMLElement;
}> = [
  {
    name: "section-hero",
    sectionType: "hero",
    legacySizeToken: "md:text-5xl",
    legacyBaseToken: "text-4xl",
    render: (section) =>
      render(
        <SectionHero section={section} colors={colors} shopName="Goat Co" />
      ),
    getHeading: () => screen.getByRole("heading", { level: 1 }),
  },
  {
    name: "section-product-description",
    sectionType: "product_description",
    legacySizeToken: "md:text-3xl",
    legacyBaseToken: "text-2xl",
    render: (section) =>
      render(
        <SectionProductDescription
          section={section}
          colors={colors}
          product={product}
        />
      ),
    getHeading: () => screen.getByRole("heading", { level: 2 }),
  },
  {
    name: "section-product-shipping-returns",
    sectionType: "product_shipping_returns",
    legacySizeToken: "md:text-3xl",
    legacyBaseToken: "text-2xl",
    render: (section) =>
      render(
        <SectionProductShippingReturns
          section={{ shippingInfo: "Ships worldwide", ...section }}
          colors={colors}
          product={product}
        />
      ),
    getHeading: () =>
      screen.getByRole("heading", { name: "Shipping & Returns" }),
  },
  {
    name: "section-product-gallery",
    sectionType: "product_gallery",
    legacySizeToken: "md:text-3xl",
    legacyBaseToken: "text-2xl",
    render: (section) =>
      render(
        <SectionProductGallery
          section={{
            heading: "Gallery",
            galleryImages: ["https://example.com/extra.jpg"],
            useProductImages: false,
            ...section,
          }}
          colors={colors}
          product={product}
        />
      ),
    getHeading: () => screen.getByRole("heading", { name: "Gallery" }),
  },
  {
    name: "section-product-specifications",
    sectionType: "product_specifications",
    legacySizeToken: "md:text-3xl",
    legacyBaseToken: "text-2xl",
    render: (section) =>
      render(
        <SectionProductSpecifications
          section={section}
          colors={colors}
          product={product}
        />
      ),
    getHeading: () =>
      screen.getByRole("heading", { name: "Specifications" }),
  },
  {
    name: "section-related-products",
    sectionType: "related_products",
    legacySizeToken: "md:text-3xl",
    legacyBaseToken: "text-2xl",
    render: (section) =>
      render(
        <SectionRelatedProducts
          section={section}
          colors={colors}
          products={[product, otherProduct]}
          currentProduct={product}
        />
      ),
    getHeading: () =>
      screen.getByRole("heading", { name: "You may also like" }),
  },
];

describe("storefront section heading class lists", () => {
  for (const {
    name,
    sectionType,
    legacySizeToken,
    legacyBaseToken,
    render: renderSection,
    getHeading,
  } of cases) {
    describe(name, () => {
      it("keeps font-bold and the legacy responsive size as separate tokens when headingSize is unset", () => {
        renderSection({ id: "s1", type: sectionType });
        expectSeparateBoldAndSize(getHeading(), legacySizeToken);
      });

      it("drops the legacy size tokens entirely when headingSize is set", () => {
        renderSection({
          id: "s1",
          type: sectionType,
          headingSize: "sm",
        });
        expectNoLegacySize(getHeading(), [legacySizeToken, legacyBaseToken]);
      });
    });
  }
});
