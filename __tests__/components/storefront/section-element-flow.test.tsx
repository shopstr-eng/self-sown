/**
 * @jest-environment jsdom
 *
 * SectionElementFlow renderer coverage (Task: drag-and-drop section layout
 * builder). The flow component is the shared layout engine every section
 * renderer delegates to, so testing it directly covers element ordering,
 * image placement, image width, and the buttons row for all section types.
 *
 * Hard constraint guarded here: a section with NONE of the new layout fields
 * must render its slots in default order inside plain fragments — no extra
 * wrapper DOM — so legacy configs produce identical markup.
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import SectionElementFlow, {
  SectionButtons,
  headingSizeClass,
  bodySizeClass,
  hasStructuralLayout,
} from "@/components/storefront/sections/section-elements";
import type { StorefrontSection } from "@/utils/types/types";

const colors = {
  primary: "#111111",
  secondary: "#222222",
  accent: "#333333",
  background: "#ffffff",
  text: "#000000",
};

const baseSection: StorefrontSection = {
  id: "s1",
  type: "about",
  heading: "Our Farm",
  body: "Raw milk from pastured cows.",
  image: "https://example.com/cow.jpg",
};

const slots = {
  heading: <h2>Our Farm</h2>,
  body: <p>Raw milk from pastured cows.</p>,
  image: <img src="https://example.com/cow.jpg" alt="cow" />,
};

function renderFlow(section: StorefrontSection, extraSlots = {}) {
  return render(
    <SectionElementFlow
      section={section}
      colors={colors}
      slots={{ ...slots, ...extraSlots }}
    />
  );
}

describe("SectionElementFlow", () => {
  it("renders slots in default order with no wrapper DOM when layout fields are unset", () => {
    const { container } = renderFlow(baseSection);
    // Children of the container are exactly the slot nodes — no flex/grid
    // wrappers injected around them.
    const children = Array.from(container.children);
    expect(children.map((c) => c.tagName)).toEqual(["H2", "P", "IMG"]);
  });

  it("honors elementOrder, ignoring unsupported/duplicate tokens", () => {
    const { container } = renderFlow({
      ...baseSection,
      elementOrder: [
        "image",
        "content", // about has no content slot — skipped
        "body",
        "body", // duplicate — deduped
        "heading",
      ],
    });
    expect(Array.from(container.children).map((c) => c.tagName)).toEqual([
      "IMG",
      "P",
      "H2",
    ]);
  });

  it("imagePlacement left/right renders a two-column row with the image in its own column", () => {
    const { container } = renderFlow({
      ...baseSection,
      imagePlacement: "left",
    });
    const row = container.firstElementChild!;
    expect(row.className).toContain("md:flex-row-reverse");
    const [textCol, imageCol] = Array.from(row.children);
    expect(textCol!.querySelector("h2")).toBeTruthy();
    expect(textCol!.querySelector("p")).toBeTruthy();
    expect(imageCol!.querySelector("img")).toBeTruthy();
  });

  it("applies imageWidth class to the image column", () => {
    const { container } = renderFlow({
      ...baseSection,
      imagePlacement: "right",
      imageWidth: 33,
    });
    const row = container.firstElementChild!;
    const imageCol = Array.from(row.children).find((c) =>
      c.querySelector("img")
    )!;
    expect(imageCol.className).toContain("md:w-1/3");
  });

  it("imagePlacement top pins the image first regardless of elementOrder", () => {
    const { container } = renderFlow({
      ...baseSection,
      elementOrder: ["heading", "body", "image"],
      imagePlacement: "top",
    });
    expect(container.firstElementChild!.tagName).toBe("IMG");
  });

  it("imagePlacement bottom pins the image last", () => {
    const { container } = renderFlow({
      ...baseSection,
      elementOrder: ["image", "heading", "body"],
      imagePlacement: "bottom",
    });
    const children = Array.from(container.children);
    expect(children[children.length - 1]!.tagName).toBe("IMG");
  });

  it("imagePlacement background layers text over the image with an overlay", () => {
    const { container } = renderFlow({
      ...baseSection,
      imagePlacement: "background",
    });
    const wrapper = container.firstElementChild!;
    expect(wrapper.className).toContain("relative");
    const bgImg = wrapper.querySelector("img[aria-hidden]");
    expect(bgImg).toBeTruthy();
    expect(wrapper.querySelector("h2")).toBeTruthy();
  });

  it("auto-renders SectionButtons from section.buttons without a slot override", () => {
    renderFlow({
      ...baseSection,
      buttons: [{ label: "Shop Now", href: "/marketplace" }],
    });
    const link = screen.getByText("Shop Now");
    expect(link).toHaveAttribute("href", "/marketplace");
  });
});

describe("SectionButtons", () => {
  it("sanitizes unsafe hrefs and drops label-less buttons", () => {
    render(
      <SectionButtons
        section={
          {
            ...baseSection,
            buttons: [
              // eslint-disable-next-line no-script-url
              { label: "Evil", href: "javascript:alert(1)" },
              { label: "" },
            ],
          } as StorefrontSection
        }
        colors={colors}
      />
    );
    const evil = screen.getByText("Evil");
    expect(evil.getAttribute("href")).not.toContain("javascript:");
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("groups consecutive same-aligned buttons into one row and starts a new row on a different alignment", () => {
    const { container } = render(
      <SectionButtons
        section={
          {
            ...baseSection,
            buttons: [
              { label: "A", align: "center" },
              { label: "B", align: "center" },
              { label: "C", align: "right" },
            ],
          } as StorefrontSection
        }
        colors={colors}
      />
    );
    const rows = Array.from(container.firstElementChild!.children);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.className).toContain("justify-center");
    expect(rows[0]!.querySelectorAll("a")).toHaveLength(2);
    expect(rows[1]!.className).toContain("justify-end");
  });

  it("renders nothing when the section has no buttons", () => {
    const { container } = render(
      <SectionButtons section={baseSection} colors={colors} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("size helpers", () => {
  it("returns the legacy fallback class when size is unset", () => {
    expect(headingSizeClass(baseSection, "text-3xl")).toBe("text-3xl");
    expect(bodySizeClass(baseSection, "text-lg")).toBe("text-lg");
  });

  it("maps size steps to responsive classes when set", () => {
    expect(
      headingSizeClass({ ...baseSection, headingSize: "xl" }, "text-3xl")
    ).toBe("text-4xl md:text-5xl");
    expect(bodySizeClass({ ...baseSection, bodySize: "sm" }, "text-lg")).toBe(
      "text-base"
    );
  });
});

describe("hasStructuralLayout", () => {
  it("is false for legacy sections and true when order/placement/width is set", () => {
    expect(hasStructuralLayout(baseSection)).toBe(false);
    expect(
      hasStructuralLayout({ ...baseSection, elementOrder: ["body"] })
    ).toBe(true);
    expect(
      hasStructuralLayout({ ...baseSection, imagePlacement: "left" })
    ).toBe(true);
    expect(hasStructuralLayout({ ...baseSection, imageWidth: 50 })).toBe(true);
  });
});
