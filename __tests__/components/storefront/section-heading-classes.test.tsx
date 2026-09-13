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
import SectionBlog from "@/components/storefront/sections/section-blog";
import SectionProducts from "@/components/storefront/sections/section-products";
import SectionFaq from "@/components/storefront/sections/section-faq";

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

// Same bug class on the body/subheading: `opacity-80${...}` once glued the
// opacity utility to the responsive size, producing `opacity-80md:text-lg`.
// Assert on the tokenized class list so merged tokens can never pass.
describe("section-product-description body class list", () => {
  const renderBody = (section: StorefrontSection) => {
    render(
      <SectionProductDescription
        section={section}
        colors={colors}
        product={product}
      />
    );
    // FormattedText renders the className on the element wrapping the text.
    return screen.getByText(product.summary);
  };

  it("keeps opacity-80 and md:text-lg as separate tokens when bodySize is unset", () => {
    const tokens = classTokens(
      renderBody({ id: "s1", type: "product_description" })
    );
    expect(tokens).toContain("opacity-80");
    expect(tokens).toContain("md:text-lg");
    expect(tokens).toContain("text-base"); // legacy base size
    for (const token of tokens) {
      expect(token.startsWith("opacity-80")).toBe(token === "opacity-80");
    }
  });

  it("drops the legacy responsive size entirely when bodySize is set", () => {
    const tokens = classTokens(
      renderBody({ id: "s1", type: "product_description", bodySize: "lg" })
    );
    expect(tokens).toContain("opacity-80");
    expect(tokens).toContain("text-xl"); // bodySize "lg"
    expect(tokens).not.toContain("md:text-lg");
  });
});

// Same bug class on the subheading pattern shared by section-blog and
// section-products: `opacity-70 ${section.bodySize ? "" : "sm:text-lg"}` —
// moving the space outside the branch would glue `opacity-70sm:text-lg`
// (or leave a dangling size). Assert on the tokenized class list.
describe("section subheading class lists (opacity-70 + sm:text-lg)", () => {
  const blogPostEvent = {
    id: "e".repeat(64),
    pubkey: "a".repeat(64),
    kind: 30023,
    created_at: 1700000000,
    content: "Post body",
    tags: [
      ["d", "first-post"],
      ["title", "First Post"],
      ["published_at", "1700000000"],
    ],
    sig: "f".repeat(128),
  };

  const subheadingCases: Array<{
    name: string;
    sectionType: StorefrontSection["type"];
    renderSubheading: (section: StorefrontSection) => Promise<HTMLElement>;
  }> = [
    {
      name: "section-blog",
      sectionType: "blog",
      renderSubheading: async (section) => {
        // jsdom has no global fetch, so assign rather than spyOn.
        (global as { fetch?: unknown }).fetch = jest
          .fn()
          .mockResolvedValueOnce({
            ok: true,
            json: async () => [blogPostEvent],
          });
        render(
          <SectionBlog
            section={section}
            colors={colors}
            shopPubkey={"a".repeat(64)}
            shopSlug="goat-co"
          />
        );
        // The subheading only renders once the posts fetch resolves.
        return screen.findByText(section.subheading!);
      },
    },
    {
      name: "section-products",
      sectionType: "products",
      renderSubheading: async (section) => {
        render(
          <SectionProducts
            section={section}
            colors={colors}
            products={[product]}
          />
        );
        return screen.getByText(section.subheading!);
      },
    },
  ];

  afterEach(() => {
    delete (global as { fetch?: unknown }).fetch;
  });

  for (const { name, sectionType, renderSubheading } of subheadingCases) {
    describe(name, () => {
      it("keeps opacity-70 and sm:text-lg as separate tokens when bodySize is unset", async () => {
        const subheading = await renderSubheading({
          id: "s1",
          type: sectionType,
          subheading: "Read our latest updates",
        });
        const tokens = classTokens(subheading);
        expect(tokens).toContain("opacity-70");
        expect(tokens).toContain("sm:text-lg");
        expect(tokens).toContain("text-base"); // legacy base size
        for (const token of tokens) {
          expect(token.startsWith("opacity-70")).toBe(token === "opacity-70");
        }
      });

      it("drops the legacy responsive size entirely when bodySize is set", async () => {
        const subheading = await renderSubheading({
          id: "s1",
          type: sectionType,
          subheading: "Read our latest updates",
          bodySize: "lg",
        });
        const tokens = classTokens(subheading);
        expect(tokens).toContain("opacity-70");
        expect(tokens).toContain("text-xl"); // bodySize "lg"
        expect(tokens).not.toContain("sm:text-lg");
        expect(tokens).not.toContain("text-base"); // legacy base overridden
      });
    });
  }
});

// Same bug class on the heading pattern shared by section-faq, section-blog
// and section-products: `break-words ${section.headingSize ? "" : "sm:text-3xl"}`
// — a one-character edit that drops the separating space would glue the size
// onto the preceding token (`break-wordssm:text-3xl`) and silently strip both
// classes. Assert on the tokenized class list so a merged token can never pass.
// Audit note: the remaining headingSizeClass/bodySizeClass consumers
// (about/story/text/reviews/testimonials/comparison/contact/contact-form/
// ingredients/social-posts) pass their fallback into the helper itself with no
// conditional suffix, so they carry no space-merge risk and need no guard.
describe("section heading class lists (font-bold + sm:text-3xl)", () => {
  const blogPostEvent = {
    id: "e".repeat(64),
    pubkey: "a".repeat(64),
    kind: 30023,
    created_at: 1700000000,
    content: "Post body",
    tags: [
      ["d", "first-post"],
      ["title", "First Post"],
      ["published_at", "1700000000"],
    ],
    sig: "f".repeat(128),
  };

  const headingCases: Array<{
    name: string;
    sectionType: StorefrontSection["type"];
    renderHeading: (section: StorefrontSection) => Promise<HTMLElement>;
  }> = [
    {
      name: "section-faq",
      sectionType: "faq",
      renderHeading: async (section) => {
        render(
          <SectionFaq
            section={{
              heading: "FAQ",
              items: [{ question: "Do you ship?", answer: "Yes" }],
              ...section,
            }}
            colors={colors}
          />
        );
        return screen.getByRole("heading", { name: "FAQ" });
      },
    },
    {
      name: "section-blog",
      sectionType: "blog",
      renderHeading: async (section) => {
        // jsdom has no global fetch, so assign rather than spyOn.
        (global as { fetch?: unknown }).fetch = jest
          .fn()
          .mockResolvedValueOnce({
            ok: true,
            json: async () => [blogPostEvent],
          });
        render(
          <SectionBlog
            section={{ heading: "From the blog", ...section }}
            colors={colors}
            shopPubkey={"a".repeat(64)}
            shopSlug="goat-co"
          />
        );
        // The heading renders inside the loaded flow; wait for the fetch.
        return screen.findByRole("heading", { name: "From the blog" });
      },
    },
    {
      name: "section-products",
      sectionType: "products",
      renderHeading: async (section) => {
        render(
          <SectionProducts
            section={{ heading: "Our products", ...section }}
            colors={colors}
            products={[product]}
          />
        );
        return screen.getByRole("heading", { name: "Our products" });
      },
    },
  ];

  afterEach(() => {
    delete (global as { fetch?: unknown }).fetch;
  });

  for (const { name, sectionType, renderHeading } of headingCases) {
    describe(name, () => {
      it("keeps font-bold and sm:text-3xl as separate tokens when headingSize is unset", async () => {
        const heading = await renderHeading({ id: "s1", type: sectionType });
        expectSeparateBoldAndSize(heading, "sm:text-3xl");
      });

      it("drops the legacy size tokens entirely when headingSize is set", async () => {
        const heading = await renderHeading({
          id: "s1",
          type: sectionType,
          headingSize: "sm",
        });
        expectNoLegacySize(heading, ["sm:text-3xl", "text-2xl"]);
      });
    });
  }
});

// The blog section's empty-shop editor-preview branch renders a SECOND heading
// markup copy (no posts yet + isPreview). It must thread headingSize through
// headingSizeClass exactly like the main heading, so a seller's custom size
// applies there too. Empty shop = no fetch needed: an empty shopPubkey flips
// `loaded` immediately.
describe("section-blog empty-state heading class list", () => {
  const renderEmptyStateHeading = async (section: StorefrontSection) => {
    render(
      <SectionBlog
        section={{ heading: "From the blog", ...section }}
        colors={colors}
        shopPubkey=""
        shopSlug="goat-co"
        isPreview
      />
    );
    return screen.findByRole("heading", { name: "From the blog" });
  };

  it("keeps font-bold and sm:text-3xl as separate tokens when headingSize is unset", async () => {
    const heading = await renderEmptyStateHeading({ id: "s1", type: "blog" });
    expectSeparateBoldAndSize(heading, "sm:text-3xl");
    expect(classTokens(heading)).toContain("text-2xl"); // legacy base size
  });

  it("drops the legacy size tokens entirely when headingSize is set", async () => {
    const heading = await renderEmptyStateHeading({
      id: "s1",
      type: "blog",
      headingSize: "sm",
    });
    expectNoLegacySize(heading, ["sm:text-3xl", "text-2xl"]);
  });
});

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
