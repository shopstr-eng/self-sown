/** @jest-environment node */

// Component test for the Tap to Pay merchant education modal itself. The
// slide content (4.5-4.8) and the pause/resume gate are covered elsewhere;
// this suite guards the navigation contract a regression would break:
//   - every slide is reachable, in order, via Next
//   - the Done button fires onDone exactly once and rewinds the pager
//   - early dismissal IS intended UX (Skip button, Android back) — the modal
//     must never wedge open — and every early exit also fires onDone exactly
//     once so the paused first charge can resume.

import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// AsyncStorage is only used by the lib's persistence helpers, not by the
// modal, but the real lib module is imported below, so give it an inert mock
// like the sibling suites.
jest.mock(
  "@react-native-async-storage/async-storage",
  () => ({
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  }),
  { virtual: true }
);

// Host-component stand-ins: the modal's behaviour lives in props/handlers,
// not in native rendering. Styles are asserted nowhere, so StyleSheet.create
// is the identity.
jest.mock("react-native", () => ({
  Modal: "Modal",
  View: "View",
  Text: "Text",
  Image: "Image",
  StyleSheet: { create: (styles: unknown) => styles },
}));

// The component imports "@/lib/...", "@/components/seller-ui", and
// "@/theme/tokens". The next/jest SWC transform rewrites those aliases with
// the ROOT tsconfig paths ("@/*" -> "./*"), so from apps/mobile/components
// they arrive at jest's resolver as relative specifiers pointing at the repo
// root (e.g. "../../../components/seller-ui"), where they don't exist.
// Register virtual mocks keyed at those same root-relative paths (as seen
// from this test file) so the component loads: the real slide data comes
// from the mobile lib; the button and theme are inert stand-ins.
jest.mock(
  "../../lib/tap-to-pay-education",
  () => jest.requireActual("../../apps/mobile/lib/tap-to-pay-education"),
  { virtual: true }
);

jest.mock(
  "../../lib/tap-to-pay-artwork",
  () => jest.requireActual("../../apps/mobile/lib/tap-to-pay-artwork"),
  { virtual: true }
);

jest.mock(
  "../../components/seller-ui",
  () => ({
    // Render a bare host node carrying the props so tests can locate buttons
    // by label and invoke onPress directly.
    ActionButton: (props: {
      label: string;
      onPress: () => void;
      variant?: "primary" | "secondary";
    }) => React.createElement("ActionButton", props),
  }),
  { virtual: true }
);

jest.mock(
  "../../theme/tokens",
  () => ({
    sellerFonts: { extrabold: "Test-Bold", regular: "Test-Regular" },
    sellerThemeTokens: {
      background: "#ffffff",
      black: "#000000",
      surface: "#ffffff",
      primary: "#00aa00",
      text: "#111111",
      mutedText: "#888888",
    },
  }),
  { virtual: true }
);

import { TAP_TO_PAY_EDUCATION_SLIDES } from "../../apps/mobile/lib/tap-to-pay-education";

// Requiring (not importing) the component keeps its "@/..." mobile aliases
// out of the root tsc program: the web tsconfig maps "@/*" to the repo root,
// where the mobile modules don't exist, so a static import would fail the
// project typecheck. Jest still resolves the module at runtime against the
// mocks registered above.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TapToPayEducationModal } =
  require("../../apps/mobile/components/tap-to-pay-education") as {
    TapToPayEducationModal: (props: {
      visible: boolean;
      onDone: () => void;
    }) => React.JSX.Element;
  };

const LAST = TAP_TO_PAY_EDUCATION_SLIDES.length - 1;

function renderModal(onDone: () => void) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <TapToPayEducationModal visible onDone={onDone} />
    );
  });
  return renderer;
}

// The react-native/seller-ui mocks are host-string stand-ins; the renderer's
// types only accept ElementType, so cast once at the lookup sites.
const host = (name: string) => name as unknown as React.ElementType;

function textContent(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : textContent(child)))
    .join("");
}

function renderedTexts(root: ReactTestInstance): string[] {
  return root.findAllByType(host("Text")).map(textContent);
}

function buttonByLabel(root: ReactTestInstance, label: string) {
  return root
    .findAllByType(host("ActionButton"))
    .find((b) => b.props.label === label);
}

function buttonLabels(root: ReactTestInstance): string[] {
  return root.findAllByType(host("ActionButton")).map((b) => b.props.label);
}

function press(root: ReactTestInstance, label: string) {
  const button = buttonByLabel(root, label);
  expect(button).toBeDefined();
  act(() => {
    button!.props.onPress();
  });
}

describe("TapToPayEducationModal slide navigation", () => {
  it("pins the intended slide order (a data reorder must fail loudly)", () => {
    // The modal renders TAP_TO_PAY_EDUCATION_SLIDES array order directly, so
    // pin the sequence Apple review will swipe through — a content reorder
    // in the lib would otherwise pass the navigation tests unnoticed.
    expect(TAP_TO_PAY_EDUCATION_SLIDES.map((s) => s.id)).toEqual([
      "contactless-cards",
      "apple-pay-wallets",
      "pin-entry",
      "fallback-payment",
    ]);
  });

  it("reaches every slide in order through Next, showing Done only on the last", () => {
    const onDone = jest.fn();
    const { root } = renderModal(onDone);

    TAP_TO_PAY_EDUCATION_SLIDES.forEach((slide, i) => {
      expect(renderedTexts(root)).toContain(slide.title);
      expect(renderedTexts(root)).toContain(slide.body);
      const isLast = i === LAST;
      expect(buttonLabels(root)).toEqual(isLast ? ["Done"] : ["Next", "Skip"]);
      if (!isLast) {
        press(root, "Next");
      }
    });

    // Navigation alone must never finish the flow: the paused first charge
    // stays behind the modal until an explicit exit.
    expect(onDone).not.toHaveBeenCalled();
  });

  it("renders Apple's approved artwork as the hero, never a self-made glyph", () => {
    // Req 4.4: the hero must be Apple's own Tap to Pay on iPhone artwork
    // (bundled via lib/tap-to-pay-artwork.ts; next/jest maps the jpg require
    // to a file mock), with an accessibility label for VoiceOver. The old
    // text-only ")))" placeholder must not come back.
    const onDone = jest.fn();
    const { root } = renderModal(onDone);
    const images = root.findAllByType(host("Image"));
    expect(images).toHaveLength(1);
    expect(images[0]!.props.source).toBeDefined();
    expect(typeof images[0]!.props.accessibilityLabel).toBe("string");
    expect(images[0]!.props.accessibilityLabel.length).toBeGreaterThan(0);
    expect(renderedTexts(root)).not.toContain(")))");
  });

  it("renders one progress dot per slide", () => {
    const onDone = jest.fn();
    const { root } = renderModal(onDone);
    // The dots row is the only View whose children are all Views, one per
    // slide.
    const dotRows = root
      .findAllByType(host("View"))
      .filter(
        (v) =>
          v.children.length === TAP_TO_PAY_EDUCATION_SLIDES.length &&
          v.children.every(
            (c) => typeof c !== "string" && c.type === host("View")
          )
      );
    expect(dotRows).toHaveLength(1);
  });

  it("Done fires onDone exactly once and rewinds the pager to the first slide", () => {
    const onDone = jest.fn();
    const { root } = renderModal(onDone);

    for (let i = 0; i < LAST; i++) {
      press(root, "Next");
    }
    press(root, "Done");

    expect(onDone).toHaveBeenCalledTimes(1);
    // Reopening the modal must start from the beginning, not a stale index.
    expect(renderedTexts(root)).toContain(
      TAP_TO_PAY_EDUCATION_SLIDES[0]!.title
    );
    expect(buttonLabels(root)).toEqual(["Next", "Skip"]);
  });

  it("Skip exits early with onDone exactly once — dismissal before the last slide is intended", () => {
    const onDone = jest.fn();
    const { root } = renderModal(onDone);

    press(root, "Next");
    press(root, "Skip");

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(renderedTexts(root)).toContain(
      TAP_TO_PAY_EDUCATION_SLIDES[0]!.title
    );
  });

  it("Skip is unavailable on the last slide, where Done is the only exit", () => {
    const onDone = jest.fn();
    const { root } = renderModal(onDone);

    for (let i = 0; i < LAST; i++) {
      press(root, "Next");
    }

    expect(buttonByLabel(root, "Skip")).toBeUndefined();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("summarizes the progress dots for VoiceOver as one 'Step X of Y' element", () => {
    // Req 4.7 accessibility bar: a screen reader must hear the pager
    // position as a single announcement, never a walk across unlabeled
    // dots. The dots row is the accessible element; each dot is hidden.
    const onDone = jest.fn();
    const { root } = renderModal(onDone);
    const TOTAL = TAP_TO_PAY_EDUCATION_SLIDES.length;

    const stepElement = () =>
      root
        .findAllByType(host("View"))
        .find(
          (v) =>
            v.props.accessible === true &&
            typeof v.props.accessibilityLabel === "string" &&
            /^Step \d+ of \d+$/.test(v.props.accessibilityLabel)
        );

    expect(stepElement()?.props.accessibilityLabel).toBe(`Step 1 of ${TOTAL}`);

    press(root, "Next");
    expect(stepElement()?.props.accessibilityLabel).toBe(`Step 2 of ${TOTAL}`);

    press(root, "Next");
    expect(stepElement()?.props.accessibilityLabel).toBe(`Step 3 of ${TOTAL}`);

    // Individual dots must never be reached by assistive tech on either
    // platform (iOS reads accessibilityElementsHidden, Android reads
    // importantForAccessibility).
    const dots = stepElement()!.children as ReactTestInstance[];
    expect(dots).toHaveLength(TOTAL);
    for (const dot of dots) {
      expect(dot.props.accessibilityElementsHidden).toBe(true);
      expect(dot.props.importantForAccessibility).toBe("no");
    }
  });

  it("marks the slide title as a header so VoiceOver can navigate by heading", () => {
    const onDone = jest.fn();
    const { root } = renderModal(onDone);
    const titles = root
      .findAllByType(host("Text"))
      .filter((t) => textContent(t) === TAP_TO_PAY_EDUCATION_SLIDES[0]!.title);
    expect(titles).toHaveLength(1);
    expect(titles[0]!.props.accessibilityRole).toBe("header");
  });

  it("Android back (Modal onRequestClose) exits with onDone exactly once", () => {
    const onDone = jest.fn();
    const { root } = renderModal(onDone);

    press(root, "Next");
    const modal = root.findByType(host("Modal"));
    expect(typeof modal.props.onRequestClose).toBe("function");
    act(() => {
      modal.props.onRequestClose();
    });

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(renderedTexts(root)).toContain(
      TAP_TO_PAY_EDUCATION_SLIDES[0]!.title
    );
  });
});
