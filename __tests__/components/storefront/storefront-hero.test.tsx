/**
 * @jest-environment jsdom
 *
 * StorefrontHero CTA readability. The hero "Browse Products" CTA pairs a
 * primary background with a secondary label; on a clashing palette
 * (yellow-on-yellow) the label must fall back to a readable color, while a
 * contrasting palette must keep the theme color byte-identical. The shared
 * helper's thresholds are boundary-tested in section-element-flow.test.tsx —
 * these tests pin that the hero CTA actually routes through it.
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import StorefrontHero from "@/components/storefront/storefront-hero";

const base = {
  shopName: "Goat Co",
  shopAbout: "",
  bannerUrl: "",
  pictureUrl: "",
  productCount: 3,
  reviewCount: 0,
};

describe("StorefrontHero CTA readability", () => {
  it("falls back to a readable label on a clashing yellow-on-yellow palette", () => {
    render(
      <StorefrontHero
        {...base}
        colors={{
          primary: "#FFD23F",
          secondary: "#FDE68A",
          accent: "#333333",
          background: "#ffffff",
          text: "#000000",
        }}
      />
    );
    const cta = screen.getByRole("link", { name: "Browse Products" });
    // Button background stays theme primary; the label must NOT be the
    // clashing theme secondary (#FDE68A) — it falls back to near-black.
    expect(cta.style.backgroundColor).toBe("rgb(255, 210, 63)"); // #FFD23F
    expect(cta.style.color).toBe("rgb(17, 24, 39)"); // #111827 fallback
  });

  it("keeps the theme secondary label when it contrasts (default palettes render byte-identical)", () => {
    render(
      <StorefrontHero
        {...base}
        colors={{
          primary: "#005cf8",
          secondary: "#94c8ff",
          accent: "#005cf8",
          background: "#ffffff",
          text: "#2f2f2f",
        }}
      />
    );
    const cta = screen.getByRole("link", { name: "Browse Products" });
    expect(cta.style.color).toBe("rgb(148, 200, 255)"); // theme secondary verbatim
  });
});
