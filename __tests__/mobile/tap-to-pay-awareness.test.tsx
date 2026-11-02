/** @jest-environment node */

// Component test for the Tap to Pay awareness moment — the full-screen pitch
// shown once to every eligible seller, the highest-visibility Tap to Pay
// marketing placement in the app. Apple's rules require the legal disclaimer
// on EVERY Tap to Pay placement, and the Apple Pay service disclaimer
// wherever Apple Pay is named (this pitch names it). A refactor that deletes
// the TapToPayDisclaimerFooter here, or drops its `mentionsApplePay` binding,
// would otherwise ship silently — the education pager has its own pairing
// test, but this screen had no render test at all.
//
// Unlike the entry-points suite (which stand-in-mocks the footer to assert
// wiring), this suite renders the REAL disclaimer footer so the assertions
// fail if the footer is removed, and presses the short disclaimer to prove
// the click-through to the product page (which is what makes the short
// "Terms apply." form legal in a tight placement).
//
// Harness pattern mirrors tap-to-pay-education-modal.test.tsx: virtual
// host-string react-native mocks + require()d component so the "@/..."
// mobile aliases stay out of the root tsc program.

import React from "react";

jest.mock(
  "react-native",
  () => ({
    Modal: "Modal",
    View: "View",
    Text: "Text",
    Image: "Image",
    Pressable: "Pressable",
    ScrollView: "ScrollView",
    StyleSheet: {
      create: (styles: unknown) => styles,
      flatten: (style: unknown) => style,
    },
  }),
  { virtual: true }
);

// The browser the short disclaimer opens on tap.
const openBrowserAsync = jest.fn(async () => ({}));
jest.mock("expo-web-browser", () => ({ openBrowserAsync }), { virtual: true });

// --- Stripe Terminal stub ---------------------------------------------------
// The awareness moment renders nothing without the native module, and the
// eligibility effect waits on getIsInitialized before showing.
const mockTerminalModule = {
  useStripeTerminal: () => ({
    discoverReaders: jest.fn(),
    connectReader: jest.fn(),
    getConnectedReader: jest.fn(),
    getLocations: jest.fn(),
    supportsReadersOfType: jest.fn(),
    getIsInitialized: jest.fn(() => true),
  }),
};

// The components import "@/..." modules; the next/jest SWC transform rewrites
// those aliases with the ROOT tsconfig paths ("@/*" -> "./*"), so they arrive
// at jest's resolver as root-relative specifiers that don't exist. Register
// virtual mocks keyed at those same root-relative paths (as seen from this
// test file). See tap-to-pay-education-modal.test.tsx for the same pattern.
jest.mock(
  "../../lib/pos-stripe-terminal",
  () => ({ getStripeTerminalModule: () => mockTerminalModule }),
  { virtual: true }
);

// Eligible seller: never seen the awareness moment, card charges enabled,
// device supports Tap to Pay — so the modal must show.
jest.mock(
  "../../lib/pos-tap-to-pay",
  () => ({
    awaitPendingTapToPayWarmup: jest.fn(async () => undefined),
    checkTapToPayDeviceSupport: jest.fn(async () => true),
    computeTapToPayEligibility: jest.fn(() => true),
    enableTapToPay: jest.fn(),
    hasSeenTapToPayAwareness: jest.fn(async () => false),
    markTapToPayAwarenessSeen: jest.fn(async () => undefined),
  }),
  { virtual: true }
);

jest.mock(
  "../../lib/pos-api",
  () => ({
    fetchPosPaymentMethods: jest.fn(async () => ({
      stripe: { chargesEnabled: true },
    })),
  }),
  { virtual: true }
);

jest.mock(
  "../../lib/tap-to-pay-artwork",
  () => jest.requireActual("../../apps/mobile/lib/tap-to-pay-artwork"),
  { virtual: true }
);

jest.mock(
  "../../lib/tap-to-pay-education",
  () => ({
    hasSeenTapToPayEducation: jest.fn(async () => true),
    markTapToPayEducationSeen: jest.fn(async () => undefined),
  }),
  { virtual: true }
);

jest.mock(
  "../../lib/api-base-url",
  () => ({ getApiBaseUrl: () => "https://self-sown.com" }),
  { virtual: true }
);

jest.mock(
  "../../lib/tap-to-pay-marketing-copy",
  () => jest.requireActual("../../apps/mobile/lib/tap-to-pay-marketing-copy"),
  { virtual: true }
);

jest.mock(
  "../../components/seller-ui",
  () => ({ ActionButton: "ActionButton" }),
  { virtual: true }
);

// The Apple Pay toolkit marks (react-native-svg) render as host stand-ins;
// their fidelity is covered by apple-pay-marks.test.tsx.
jest.mock(
  "../../components/apple-pay-mark",
  () => ({ ApplePayMark: "ApplePayMark", ApplePayLogo: "ApplePayLogo" }),
  { virtual: true }
);

// The education modal's own rendering/navigation is covered by
// tap-to-pay-education-modal.test.tsx; here a host stand-in keeps the tree
// shallow.
jest.mock(
  "../../components/tap-to-pay-education",
  () => ({
    TapToPayEducationModal: (props: { visible: boolean; onDone: () => void }) =>
      React.createElement("TapToPayEducationModal", props),
  }),
  { virtual: true }
);

// NOTE: the disclaimer footer is deliberately the REAL component (only
// redirected to the mobile path so jest can resolve it) — the point of this
// suite is that the actual footer, and its Apple Pay service disclaimer
// binding, is on the awareness screen.
jest.mock(
  "../../components/tap-to-pay-disclaimer",
  () =>
    jest.requireActual("../../apps/mobile/components/tap-to-pay-disclaimer"),
  { virtual: true }
);

jest.mock(
  "../../theme/tokens",
  () => ({
    sellerFonts: {
      extrabold: "Test-Extrabold",
      regular: "Test-Regular",
      semibold: "Test-Semibold",
    },
    sellerThemeTokens: {
      background: "#ffffff",
      danger: "#ff0000",
      mutedText: "#888888",
      primary: "#00aa00",
      success: "#00aa00",
      text: "#111111",
    },
  }),
  { virtual: true }
);

import {
  APPLE_PAY_SERVICE_DISCLAIMER,
  TAP_TO_PAY_PRODUCT_PAGE_PATH,
  TAP_TO_PAY_SHORT_DISCLAIMER,
} from "../../apps/mobile/lib/tap-to-pay-marketing-copy";

// Requiring (not importing) @testing-library/react-native keeps the
// jest.mock("react-native", ...) registration above in effect when RNTL
// loads: the next/jest SWC transform does NOT hoist jest.mock calls above
// static ESM imports, and RNTL requires the real (ESM, untransformed)
// react-native at module load, which would crash before the mock registers.
// NOTE: RNTL v14's exported `screen` is a placeholder proxy that render()
// REPLACES, so never destructure it — use the render() result's queries.
const { render, act, fireEvent } =
  require("@testing-library/react-native") as typeof import("@testing-library/react-native");

// Requiring (not importing) the component keeps its "@/..." mobile aliases
// out of the root tsc program: the web tsconfig maps "@/*" to the repo root,
// where the mobile modules don't exist, so a static import would fail the
// project typecheck. Jest resolves the module at runtime against the mocks
// registered above.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TapToPayAwarenessMoment } =
  require("../../apps/mobile/components/tap-to-pay-awareness") as {
    TapToPayAwarenessMoment: React.ComponentType<{
      session: { pubkey: string } | null;
    }>;
  };

type RenderResult = Awaited<ReturnType<typeof render>>;

// The current render, refreshed by renderAwareness. RNTL's auto cleanup
// unmounts after each test, so tests only ever see their own tree.
let app: RenderResult;

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

// Render the moment and wait for the eligibility effect to open the modal.
async function renderAwareness() {
  app = await render(
    React.createElement(TapToPayAwarenessMoment, {
      session: { pubkey: "pk-seller" },
    })
  );
  await flush();
  // Precondition for every assertion below: the pitch is actually showing.
  expect(app.getByText("Tap to Pay on iPhone")).toBeTruthy();
}

describe("TapToPayAwarenessMoment legal disclaimer pairing", () => {
  beforeEach(() => {
    openBrowserAsync.mockClear();
  });

  it("renders the short disclaimer and the Apple Pay service notice on the pitch", async () => {
    // Apple's marketing rules: a legal disclaimer must accompany EVERY Tap to
    // Pay placement, and this pitch names Apple Pay, so the Apple Pay service
    // disclaimer must ride along. Removing the footer — or dropping its
    // mentionsApplePay binding — must fail this test.
    await renderAwareness();
    expect(app.getByText(TAP_TO_PAY_SHORT_DISCLAIMER)).toBeTruthy();
    expect(app.getByText(APPLE_PAY_SERVICE_DISCLAIMER)).toBeTruthy();
  });

  it("clicks the short disclaimer through to the Tap to Pay product page", async () => {
    // The short "Terms apply." form is only legal because it clicks through
    // to the product page showing the full disclaimer — a footer that stops
    // linking there (or links elsewhere) breaks compliance.
    await renderAwareness();
    await fireEvent.press(app.getByText(TAP_TO_PAY_SHORT_DISCLAIMER));
    expect(openBrowserAsync).toHaveBeenCalledTimes(1);
    expect(openBrowserAsync).toHaveBeenCalledWith(
      `https://self-sown.com${TAP_TO_PAY_PRODUCT_PAGE_PATH}`
    );
  });

  it("lays out scrollably so the disclaimer stays reachable on small phones", async () => {
    // Artwork + pitch + legal notice exceed a small iPhone screen; a
    // non-scrollable container would clip the disclaimer off-screen, which is
    // the same compliance failure as removing it.
    await renderAwareness();
    const scrollViews = app.container.queryAll(
      (node) => node.type === "ScrollView"
    );
    expect(scrollViews.length).toBeGreaterThan(0);
  });
});
