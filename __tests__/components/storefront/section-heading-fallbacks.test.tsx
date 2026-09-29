/**
 * @jest-environment jsdom
 *
 * Heading-hierarchy regression guard for storefront sections.
 *
 * SEO scans of live stalls flagged "heading hierarchy skips H1 to H3": when a
 * seller leaves a section's heading blank, the section rendered no h2 but its
 * items (product cards, ingredient names, timeline entries) render h3 titles
 * directly under the page h1. The fix renders a visually-hidden h2 fallback at
 * the top of the CONTENT slot — inside the content slot (not the heading
 * slot) so a seller-saved elementOrder that places content before the heading
 * can never put item h3s ahead of the fallback.
 *
 * These tests pin that contract per section: no heading configured + items
 * present => exactly one sr-only h2 precedes every h3 in DOM order; heading
 * configured => the visible h2 is used and no sr-only fallback appears.
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import type { StorefrontSection } from "@/utils/types/types";
import type { ProductData } from "@/utils/parsers/product-parser-functions";
import SectionProducts from "@/components/storefront/sections/section-products";
import SectionIngredients from "@/components/storefront/sections/section-ingredients";
import SectionStory from "@/components/storefront/sections/section-story";

// The grid pulls in ProductCard (cart/wallet contexts); the heading under
// test is rendered before it, so stub the grid out.
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

const makeSection = (
  type: StorefrontSection["type"],
  overrides: Partial<StorefrontSection> = {}
): StorefrontSection => ({ id: `s-${type}`, type, ...overrides });

// Heading levels in DOM order, e.g. ["H2", "H3", "H3"].
const headingTags = (container: HTMLElement): string[] =>
  Array.from(container.querySelectorAll("h1,h2,h3,h4,h5,h6")).map(
    (el) => el.tagName
  );

describe("products section heading fallback", () => {
  it("renders an sr-only h2 when the heading is blank", () => {
    const { container } = render(
      <SectionProducts
        section={makeSection("products")}
        colors={colors}
        products={[product]}
      />
    );
    const h2 = screen.getByRole("heading", { level: 2 });
    expect(h2).toHaveTextContent("Products");
    expect(h2).toHaveClass("sr-only");
    expect(headingTags(container)[0]).toBe("H2");
  });

  it("keeps the fallback h2 ahead of the grid when content is ordered before the heading", () => {
    render(
      <SectionProducts
        section={makeSection("products", {
          elementOrder: ["content", "heading"],
        })}
        colors={colors}
        products={[product]}
      />
    );
    const h2 = screen.getByRole("heading", { level: 2 });
    const grid = screen.getByTestId("product-grid");
    expect(
      h2.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("uses the configured heading with no sr-only fallback", () => {
    render(
      <SectionProducts
        section={makeSection("products", { heading: "Shop the farm" })}
        colors={colors}
        products={[product]}
      />
    );
    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent("Shop the farm");
    expect(headings[0]).not.toHaveClass("sr-only");
  });
});

describe("ingredients section heading fallback", () => {
  it("renders an sr-only h2 ahead of item h3s when the heading is blank", () => {
    const { container } = render(
      <SectionIngredients
        section={makeSection("ingredients", {
          ingredientItems: [{ name: "Raw honey" }],
        })}
        colors={colors}
      />
    );
    const h2 = screen.getByRole("heading", { level: 2 });
    expect(h2).toHaveTextContent("Ingredients");
    expect(h2).toHaveClass("sr-only");
    // item names remain h3, and the fallback h2 precedes them in DOM order
    expect(
      screen.getByRole("heading", { level: 3, name: "Raw honey" })
    ).toBeInTheDocument();
    expect(headingTags(container)).toEqual(["H2", "H3"]);
  });

  it("keeps the h2 first when content is ordered before the heading", () => {
    const { container } = render(
      <SectionIngredients
        section={makeSection("ingredients", {
          ingredientItems: [{ name: "Raw honey" }],
          elementOrder: ["content", "heading"],
        })}
        colors={colors}
      />
    );
    expect(headingTags(container)).toEqual(["H2", "H3"]);
  });

  it("renders no fallback heading when there are no items", () => {
    render(
      <SectionIngredients
        section={makeSection("ingredients")}
        colors={colors}
      />
    );
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });
});

describe("story section heading fallback", () => {
  it("renders an sr-only h2 ahead of timeline h3s when the heading is blank", () => {
    const { container } = render(
      <SectionStory
        section={makeSection("story", {
          timelineItems: [{ heading: "2019", body: "We started." }],
        })}
        colors={colors}
      />
    );
    const h2 = screen.getByRole("heading", { level: 2 });
    expect(h2).toHaveTextContent("Story");
    expect(h2).toHaveClass("sr-only");
    expect(
      screen.getByRole("heading", { level: 3, name: "2019" })
    ).toBeInTheDocument();
    expect(headingTags(container)).toEqual(["H2", "H3"]);
  });

  it("renders no fallback heading when there are no timeline items", () => {
    render(<SectionStory section={makeSection("story")} colors={colors} />);
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });
});

describe("seller-reordered sections with a visible heading", () => {
  it("products: emits an sr-only h2 before the grid when content precedes the heading", () => {
    render(
      <SectionProducts
        section={makeSection("products", {
          heading: "Shop the farm",
          elementOrder: ["content", "heading"],
        })}
        colors={colors}
        products={[product]}
      />
    );
    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings).toHaveLength(2);
    expect(headings[0]).toHaveTextContent("Products");
    expect(headings[0]).toHaveClass("sr-only");
    const grid = screen.getByTestId("product-grid");
    const fallback = headings[0];
    expect(fallback).toBeDefined();
    expect(
      fallback!.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("ingredients: keeps an h2 ahead of item h3s when content precedes the heading", () => {
    const { container } = render(
      <SectionIngredients
        section={makeSection("ingredients", {
          heading: "Inside the jar",
          ingredientItems: [{ name: "Raw honey" }],
          elementOrder: ["content", "heading"],
        })}
        colors={colors}
      />
    );
    expect(headingTags(container)).toEqual(["H2", "H3", "H2"]);
  });

  it("story: keeps an h2 ahead of timeline h3s when content precedes the heading", () => {
    const { container } = render(
      <SectionStory
        section={makeSection("story", {
          heading: "Our story",
          timelineItems: [{ heading: "2019", body: "We started." }],
          elementOrder: ["content", "heading"],
        })}
        colors={colors}
      />
    );
    expect(headingTags(container)).toEqual(["H2", "H3", "H2"]);
  });
});
