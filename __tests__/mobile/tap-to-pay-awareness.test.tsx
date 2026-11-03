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

// Mutable so the Android describe block can flip the platform; the mock
// factory reads it lazily through the getter at render time.
let mockPlatformOS = "ios";
jest.mock(
  "react-native",
  () => ({
    Modal: "Modal",
    View: "View",
    Text: "Text",
    Image: "Image",
    Pressable: "Pressable",
    ScrollView: "ScrollView",
    Platform: {
      get OS() {
        return mockPlatformOS;
      },
    },
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

// The not-connected error path offers an "Open payment settings" action that
// routes to the home tab's Stripe card.
const mockRouterPush = jest.fn();
jest.mock(
  "expo-router",
  () => ({ useRouter: () => ({ push: mockRouterPush }) }),
  { virtual: true }
);

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
// Per-test controllable handles for the enable flow: the SDK-init failure
// mapping lives in describeTapToPayEnableFailure, which the modal must call
// instead of showing raw SDK errors. (The rest-param signatures keep the
// (...args) wrappers below assignable under the root tsc program.)
const mockEnableTapToPay = jest.fn(
  async (..._args: unknown[]): Promise<{ ok: boolean; error?: string }> => ({
    ok: true,
  })
);
const mockDescribeFailure = jest.fn(
  async (
    ..._args: unknown[]
  ): Promise<{ message: string; needsStripeConnect: boolean }> => ({
    message: "Could not enable Tap to Pay.",
    needsStripeConnect: false,
  })
);
jest.mock(
  "../../lib/pos-tap-to-pay",
  () => ({
    awaitPendingTapToPayWarmup: jest.fn(async () => undefined),
    checkTapToPayDeviceSupport: jest.fn(async () => true),
    computeTapToPayEligibility: jest.fn(() => true),
    describeTapToPayEnableFailure: (...args: unknown[]) =>
      mockDescribeFailure(...args),
    enableTapToPay: (...args: unknown[]) => mockEnableTapToPay(...args),
    hasSeenTapToPayAwareness: jest.fn(async () => false),
    markTapToPayAwarenessSeen: jest.fn(async () => undefined),
  }),
  { virtual: true }
);

jest.mock(
  "../../lib/pos-api",
  () => ({
    createStripeTerminalConnectionToken: jest.fn(async () => ({
      secret: "pst_test",
    })),
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

// Functional ActionButton (not a host string) so tests can press buttons by
// label — the enable and payment-settings actions are behavior under test.
jest.mock(
  "../../components/seller-ui",
  () => ({
    ActionButton: (props: {
      label: string;
      onPress?: () => void;
      variant?: string;
    }) =>
      React.createElement(
        "Pressable",
        { onPress: props.onPress, accessibilityLabel: props.label },
        React.createElement("Text", null, props.label)
      ),
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
} from "../../packages/domain/src/tap-to-pay-marketing-copy";

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

describe("TapToPayAwarenessMoment enable failure guidance", () => {
  beforeEach(() => {
    mockRouterPush.mockClear();
    mockEnableTapToPay.mockReset();
    mockEnableTapToPay.mockResolvedValue({ ok: true });
    mockDescribeFailure.mockReset();
    mockDescribeFailure.mockResolvedValue({
      message: "Could not enable Tap to Pay.",
      needsStripeConnect: false,
    });
  });

  it("points to payment settings when enablement fails because Stripe is not connected", async () => {
    // The SDK's generic init error is what a seller without a charges-enabled
    // Stripe account actually hits (the tokenProvider's 403 is swallowed by
    // SDK init); the resolver maps it to the connect-Stripe action.
    mockEnableTapToPay.mockResolvedValue({
      ok: false,
      error:
        "First initialize the Stripe Terminal SDK before performing any action",
    });
    mockDescribeFailure.mockResolvedValue({
      message: "Connect a Stripe account with card charges to use Tap to Pay.",
      needsStripeConnect: true,
    });
    await renderAwareness();
    await fireEvent.press(app.getByLabelText("Turn on Tap to Pay"));
    await flush();
    expect(
      app.getByText(
        "Connect a Stripe account with card charges to use Tap to Pay."
      )
    ).toBeTruthy();
    await fireEvent.press(app.getByLabelText("Open payment settings"));
    expect(mockRouterPush).toHaveBeenCalledWith("/(tabs)");
  });

  it("never shows the raw SDK init error verbatim", async () => {
    mockEnableTapToPay.mockResolvedValue({
      ok: false,
      error:
        "First initialize the Stripe Terminal SDK before performing any action",
    });
    await renderAwareness();
    await fireEvent.press(app.getByLabelText("Turn on Tap to Pay"));
    await flush();
    expect(mockDescribeFailure).toHaveBeenCalledTimes(1);
    expect(
      app.queryByText(/First initialize the Stripe Terminal SDK/i)
    ).toBeNull();
    expect(app.getByText("Could not enable Tap to Pay.")).toBeTruthy();
  });
});

describe("TapToPayAwarenessMoment on Android", () => {
  beforeEach(() => {
    mockPlatformOS = "android";
  });
  afterEach(() => {
    mockPlatformOS = "ios";
  });

  it("pitches with device-neutral copy and no Apple artwork, mark, or disclaimer", async () => {
    // Apple's review-mandated wording/artwork binds only on iOS. On Android
    // the same moment must not show iPhone wording, the Apple Pay lockup, or
    // the Apple legal footer (no Apple requirement applies there).
    app = await render(
      React.createElement(TapToPayAwarenessMoment, {
        session: { pubkey: "pk-seller" },
      })
    );
    await flush();
    expect(app.getByText("Tap to Pay")).toBeTruthy();
    expect(app.queryByText("Tap to Pay on iPhone")).toBeNull();
    expect(app.queryByText(/iPhone/)).toBeNull();
    expect(app.queryByText(/Apple/)).toBeNull();
    expect(
      app.getByText(
        "Accept contactless cards and digital wallets in person — right on this phone, no extra hardware."
      )
    ).toBeTruthy();
    expect(app.queryByText(TAP_TO_PAY_SHORT_DISCLAIMER)).toBeNull();
    expect(app.queryByText(APPLE_PAY_SERVICE_DISCLAIMER)).toBeNull();
    // Apple's approved iPhone hero renders only on iOS (Req 4.4 artwork).
    expect(
      app.container.queryAll((node) => node.type === "Image").length
    ).toBe(0);
    expect(
      app.container.queryAll((node) => node.type === "ApplePayLogo").length
    ).toBe(0);
  });

  it("uses device-neutral enable phase wording", async () => {
    app = await render(
      React.createElement(TapToPayAwarenessMoment, {
        session: { pubkey: "pk-seller" },
      })
    );
    await flush();
    // Hold the enable flow in the discovering phase so its label renders.
    let resolveEnable: ((value: { ok: boolean }) => void) | undefined;
    mockEnableTapToPay.mockImplementation(
      () =>
        new Promise<{ ok: boolean }>((resolve) => {
          resolveEnable = resolve;
        })
    );
    await fireEvent.press(app.getByLabelText("Turn on Tap to Pay"));
    await flush();
    expect(
      app.getByText("Preparing Tap to Pay on this phone...")
    ).toBeTruthy();
    expect(app.queryByText(/iPhone/)).toBeNull();
    resolveEnable?.({ ok: true });
    await flush();
    mockEnableTapToPay.mockReset();
    mockEnableTapToPay.mockResolvedValue({ ok: true });
  });
});
