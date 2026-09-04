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

describe("SectionElementFlow — text readability rules", () => {
  // jsdom serializes hex inline colors as rgb() in .style but keeps custom
  // properties verbatim — assert .style.color/.style.borderColor as rgb and
  // --sf-text as the original hex.
  const WHITE = "rgb(255, 255, 255)";
  const NEAR_BLACK = "rgb(17, 24, 39)"; // #111827

  function renderWithColors(
    customColors: typeof colors,
    section: StorefrontSection
  ) {
    return render(
      <SectionElementFlow
        section={section}
        colors={customColors}
        slots={slots}
      />
    );
  }

  // The overlay content wrapper is the direct parent of the body slot under
  // background image placement.
  function overlayWrapper(): HTMLElement {
    const wrapper = screen.getByText(
      "Raw milk from pastured cows."
    ).parentElement;
    if (!wrapper) throw new Error("overlay wrapper not found");
    return wrapper;
  }

  const bgImageSection: StorefrontSection = {
    ...baseSection,
    imagePlacement: "background",
  };

  it("picks white overlay text (color + --sf-text) over a dark overlay color", () => {
    // The overlay paints with colors.secondary; #111827 is dark.
    renderWithColors({ ...colors, secondary: "#111827" }, bgImageSection);
    const wrapper = overlayWrapper();
    expect(wrapper.style.color).toBe(WHITE);
    expect(wrapper.style.getPropertyValue("--sf-text")).toBe("#ffffff");
  });

  it("picks near-black overlay text (color + --sf-text) over a light overlay color", () => {
    // #FDE68A is a light yellow overlay.
    renderWithColors({ ...colors, secondary: "#FDE68A" }, bgImageSection);
    const wrapper = overlayWrapper();
    expect(wrapper.style.color).toBe(NEAR_BLACK);
    expect(wrapper.style.getPropertyValue("--sf-text")).toBe("#111827");
  });

  const buttonSection: StorefrontSection = {
    ...baseSection,
    buttons: [
      { label: "Buy now", href: "/buy", variant: "primary" },
      { label: "Learn more", href: "/about", variant: "secondary" },
    ],
  };

  it("falls back to a readable label when the theme label color clashes with the button background", () => {
    // Yellow-on-yellow: #FFD23F vs #FDE68A differ by <0.3 luminance, and
    // #FDE68A vs the white page background too.
    renderWithColors(
      {
        ...colors,
        primary: "#FFD23F",
        secondary: "#FDE68A",
        background: "#ffffff",
      },
      buttonSection
    );
    const primaryBtn = screen.getByRole("link", { name: "Buy now" });
    const secondaryBtn = screen.getByRole("link", { name: "Learn more" });
    // Neither keeps its illegible theme label color.
    expect(primaryBtn.style.color).toBe(NEAR_BLACK);
    expect(primaryBtn.style.color).not.toBe("rgb(253, 230, 138)"); // #FDE68A
    expect(secondaryBtn.style.color).toBe(NEAR_BLACK);
    expect(secondaryBtn.style.color).not.toBe(WHITE); // theme background
  });

  it("keeps the theme label color when it contrasts with the button background", () => {
    // #FFD23F vs #0F172A differ by >0.3 luminance; #0F172A vs white too.
    renderWithColors(
      {
        ...colors,
        primary: "#FFD23F",
        secondary: "#0F172A",
        background: "#ffffff",
      },
      buttonSection
    );
    expect(screen.getByRole("link", { name: "Buy now" }).style.color).toBe(
      "rgb(15, 23, 42)" // theme secondary kept on the primary button
    );
    expect(screen.getByRole("link", { name: "Learn more" }).style.color).toBe(
      WHITE // theme background kept on the secondary button
    );
  });

  const outlineSection: StorefrontSection = {
    ...baseSection,
    imagePlacement: "background",
    buttons: [{ label: "Browse", href: "/shop", variant: "outline" }],
  };

  it("falls back the outline accent when the primary color blends into the overlay surface", () => {
    // Under background placement the outline button sits on the overlay
    // (colors.secondary #111827); primary #1F2937 is <0.3 luminance away.
    renderWithColors(
      { ...colors, primary: "#1F2937", secondary: "#111827" },
      outlineSection
    );
    const btn = screen.getByRole("link", { name: "Browse" });
    expect(btn.style.color).toBe(WHITE);
    expect(btn.style.borderColor).toBe(WHITE);
  });

  it("keeps the primary outline accent when it contrasts with the overlay surface", () => {
    // #FFD23F pops against the dark #111827 overlay.
    renderWithColors(
      { ...colors, primary: "#FFD23F", secondary: "#111827" },
      outlineSection
    );
    const btn = screen.getByRole("link", { name: "Browse" });
    expect(btn.style.color).toBe("rgb(255, 210, 63)"); // #FFD23F
    expect(btn.style.borderColor).toBe("rgb(255, 210, 63)");
  });

  // Boundary tests: the palettes above are far from the decision boundaries,
  // so they can't catch a threshold/pivot regression. Grayscale luminance is
  // exactly NN/255 (the 0.299/0.587/0.114 weights sum to 1), which puts
  // precise steps on both sides of each rule.

  const thresholdSection: StorefrontSection = {
    ...baseSection,
    buttons: [{ label: "Buy now", href: "/buy", variant: "primary" }],
  };

  it("falls back one grayscale step below the 0.3 clash threshold", () => {
    // Against a #000 button the luminance diff is the label gray itself:
    // #4C = 76/255 ≈ 0.298 < 0.3.
    renderWithColors(
      { ...colors, primary: "#000000", secondary: "#4C4C4C" },
      thresholdSection
    );
    expect(screen.getByRole("link", { name: "Buy now" }).style.color).toBe(
      WHITE
    );
  });

  it("keeps the theme label at exactly the 0.3 clash threshold (the rule is >=)", () => {
    // #026A78 against #000: (0.299*2 + 0.587*106 + 0.114*120)/255 = 76.5/255
    // = 0.3 exactly — the diff IS the label luminance, and >= keeps it (a
    // regression to > would fall back to white).
    renderWithColors(
      { ...colors, primary: "#000000", secondary: "#026A78" },
      thresholdSection
    );
    expect(screen.getByRole("link", { name: "Buy now" }).style.color).toBe(
      "rgb(2, 106, 120)" // #026A78 kept — no fallback
    );
  });

  it("keeps white overlay text at exactly the 0.6 luminance pivot (the rule is strict >)", () => {
    // #999999 = 153/255 = 0.6 exactly — NOT > 0.6, so text stays white.
    renderWithColors({ ...colors, secondary: "#999999" }, bgImageSection);
    const wrapper = overlayWrapper();
    expect(wrapper.style.color).toBe(WHITE);
    expect(wrapper.style.getPropertyValue("--sf-text")).toBe("#ffffff");
  });

  it("flips to near-black overlay text one step above the 0.6 pivot", () => {
    // #9A9A9A = 154/255 ≈ 0.604 > 0.6.
    renderWithColors({ ...colors, secondary: "#9A9A9A" }, bgImageSection);
    const wrapper = overlayWrapper();
    expect(wrapper.style.color).toBe(NEAR_BLACK);
    expect(wrapper.style.getPropertyValue("--sf-text")).toBe("#111827");
  });
});
