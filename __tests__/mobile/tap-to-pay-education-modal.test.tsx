/** @jest-environment node */

// Component test for the Tap to Pay merchant education modal itself. The
// slide content (4.5-4.8) and the pause/resume gate are covered elsewhere;
// this suite guards the navigation contract a regression would break:
//   - every slide is reachable, in order, via Next
//   - the Done button fires onDone exactly once and rewinds the pager
//   - early dismissal IS intended UX (Skip button, Android back) — the modal
//     must never wedge open — and every early exit also fires onDone exactly
//     once so the paused first charge can resume.
//
// Rendered with @testing-library/react-native (v14+, backed by the
// maintained `test-renderer` package) — NOT react-test-renderer, which React
// upstream deprecated. New mobile component tests must copy this pattern:
// host-string react-native mocks + `await render(...)` + queries bound to
// the render() result / `container.queryAll(...)`.

import React from "react";

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
// is the identity; @testing-library/react-native reads StyleSheet.flatten
// internally (pointer-events/visibility checks), so it must exist too.
// virtual: true so the mock intercepts by raw specifier from ANY module —
// @testing-library/react-native requires "react-native" internally, and
// under pnpm that resolves to a peer-context path that never matches a
// non-virtual mock registered from this file.
jest.mock(
  "react-native",
  () => ({
    Modal: "Modal",
    View: "View",
    Text: "Text",
    Image: "Image",
    StyleSheet: {
      create: (styles: unknown) => styles,
      flatten: (style: unknown) => style,
    },
  }),
  { virtual: true }
);

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
    // by label and fireEvent.press them directly.
    ActionButton: (props: {
      label: string;
      onPress: () => void;
      variant?: "primary" | "secondary";
    }) => React.createElement("ActionButton", props),
  }),
  { virtual: true }
);

// The Apple Pay toolkit marks (react-native-svg) render as host stand-ins;
// their fidelity is covered by apple-pay-marks.test.tsx.
jest.mock(
  "../../components/apple-pay-mark",
  () => ({ ApplePayMark: "ApplePayMark", ApplePayLogo: "ApplePayLogo" }),
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

// Requiring (not importing) @testing-library/react-native keeps the
// jest.mock("react-native", ...) registration above in effect when RNTL
// loads: the next/jest SWC transform does NOT hoist jest.mock calls above
// static ESM imports, and RNTL requires the real (ESM, untransformed)
// react-native at module load, which would crash before the mock registers.
// NOTE: RNTL v14's exported `screen` is a placeholder proxy that render()
// REPLACES, so destructuring it would capture a stale object — always use
// the queries bound to the render() result instead.
const { render, fireEvent } =
  require("@testing-library/react-native") as typeof import("@testing-library/react-native");

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

type RenderResult = Awaited<ReturnType<typeof render>>;

// The host-node type `container.queryAll` returns. The concrete TestInstance
// class comes from RNTL's nested `test-renderer` package, which the root tsc
// program cannot import by name, so derive it from the render result
// instead. (A hand-written structural type does NOT work: fireEvent requires
// the real TestInstance, which has private members.)
type HostNode = RenderResult["container"];

// The current render, refreshed by every renderModal call. RNTL's auto
// cleanup unmounts after each test, so tests only ever see their own tree.
let app: RenderResult;

async function renderModal(onDone: () => void) {
  app = await render(<TapToPayEducationModal visible onDone={onDone} />);
}

function hostNodesOfType(name: string): HostNode[] {
  return app.container.queryAll((node) => node.type === name);
}

function buttonByLabel(label: string): HostNode | undefined {
  return hostNodesOfType("ActionButton").find(
    (b) => b.props.label === label
  );
}

function buttonLabels(): string[] {
  return hostNodesOfType("ActionButton").map((b) => b.props.label);
}

async function press(label: string) {
  const button = buttonByLabel(label);
  expect(button).toBeDefined();
  await fireEvent.press(button!);
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

  it("reaches every slide in order through Next, showing Done only on the last", async () => {
    const onDone = jest.fn();
    await renderModal(onDone);

    for (const [i, slide] of TAP_TO_PAY_EDUCATION_SLIDES.entries()) {
      expect(app.getByText(slide.title)).toBeTruthy();
      expect(app.getByText(slide.body)).toBeTruthy();
      const isLast = i === LAST;
      expect(buttonLabels()).toEqual(isLast ? ["Done"] : ["Next", "Skip"]);
      if (!isLast) {
        await press("Next");
      }
    }

    // Navigation alone must never finish the flow: the paused first charge
    // stays behind the modal until an explicit exit.
    expect(onDone).not.toHaveBeenCalled();
  });

  it("renders Apple's approved artwork as the hero, never a self-made glyph", async () => {
    // Req 4.4: the hero must be Apple's own Tap to Pay on iPhone artwork
    // (bundled via lib/tap-to-pay-artwork.ts; next/jest maps the jpg require
    // to a file mock), with an accessibility label for VoiceOver. The old
    // text-only ")))" placeholder must not come back.
    const onDone = jest.fn();
    await renderModal(onDone);
    const images = hostNodesOfType("Image");
    expect(images).toHaveLength(1);
    expect(images[0]!.props.source).toBeDefined();
    expect(typeof images[0]!.props.accessibilityLabel).toBe("string");
    expect(images[0]!.props.accessibilityLabel.length).toBeGreaterThan(0);
    expect(app.queryByText(")))")).toBeNull();
  });

  it("renders one progress dot per slide", async () => {
    const onDone = jest.fn();
    await renderModal(onDone);
    // The dots row is the only View whose children are all Views, one per
    // slide.
    const dotRows = hostNodesOfType("View").filter(
      (v) =>
        v.children.length === TAP_TO_PAY_EDUCATION_SLIDES.length &&
        v.children.every(
          (c) => typeof c !== "string" && c.type === "View"
        )
    );
    expect(dotRows).toHaveLength(1);
  });

  it("Done fires onDone exactly once and rewinds the pager to the first slide", async () => {
    const onDone = jest.fn();
    await renderModal(onDone);

    for (let i = 0; i < LAST; i++) {
      await press("Next");
    }
    await press("Done");

    expect(onDone).toHaveBeenCalledTimes(1);
    // Reopening the modal must start from the beginning, not a stale index.
    expect(
      app.getByText(TAP_TO_PAY_EDUCATION_SLIDES[0]!.title)
    ).toBeTruthy();
    expect(buttonLabels()).toEqual(["Next", "Skip"]);
  });

  it("Skip exits early with onDone exactly once — dismissal before the last slide is intended", async () => {
    const onDone = jest.fn();
    await renderModal(onDone);

    await press("Next");
    await press("Skip");

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(
      app.getByText(TAP_TO_PAY_EDUCATION_SLIDES[0]!.title)
    ).toBeTruthy();
  });

  it("Skip is unavailable on the last slide, where Done is the only exit", async () => {
    const onDone = jest.fn();
    await renderModal(onDone);

    for (let i = 0; i < LAST; i++) {
      await press("Next");
    }

    expect(buttonByLabel("Skip")).toBeUndefined();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("summarizes the progress dots for VoiceOver as one 'Step X of Y' element", async () => {
    // Req 4.7 accessibility bar: a screen reader must hear the pager
    // position as a single announcement, never a walk across unlabeled
    // dots. The dots row is the accessible element; each dot is hidden.
    const onDone = jest.fn();
    await renderModal(onDone);
    const TOTAL = TAP_TO_PAY_EDUCATION_SLIDES.length;

    const stepElement = () => app.getByLabelText(/^Step \d+ of \d+$/);

    expect(stepElement().props.accessibilityLabel).toBe(`Step 1 of ${TOTAL}`);

    await press("Next");
    expect(stepElement().props.accessibilityLabel).toBe(`Step 2 of ${TOTAL}`);

    await press("Next");
    expect(stepElement().props.accessibilityLabel).toBe(`Step 3 of ${TOTAL}`);

    // Individual dots must never be reached by assistive tech on either
    // platform (iOS reads accessibilityElementsHidden, Android reads
    // importantForAccessibility).
    const dots = stepElement().children as HostNode[];
    expect(dots).toHaveLength(TOTAL);
    for (const dot of dots) {
      expect(dot.props.accessibilityElementsHidden).toBe(true);
      expect(dot.props.importantForAccessibility).toBe("no");
    }
  });

  it("marks the slide title as a header so VoiceOver can navigate by heading", async () => {
    const onDone = jest.fn();
    await renderModal(onDone);
    const title = app.getByText(TAP_TO_PAY_EDUCATION_SLIDES[0]!.title);
    expect(title.props.accessibilityRole).toBe("header");
  });

  it("Android back (Modal onRequestClose) exits with onDone exactly once", async () => {
    const onDone = jest.fn();
    await renderModal(onDone);

    await press("Next");
    const modal = hostNodesOfType("Modal")[0];
    expect(modal).toBeDefined();
    expect(typeof modal!.props.onRequestClose).toBe("function");
    await fireEvent(modal!, "requestClose");

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(
      app.getByText(TAP_TO_PAY_EDUCATION_SLIDES[0]!.title)
    ).toBeTruthy();
  });
});
