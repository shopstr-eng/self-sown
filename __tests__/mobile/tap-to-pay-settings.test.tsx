/** @jest-environment node */

// Render test for the Settings > Tap to Pay screen's not-connected guidance.
// Sellers without a charges-enabled Stripe account used to hit the raw
// "First initialize the Stripe Terminal SDK" error with no hint that
// connecting Stripe is the fix: the SDK's init eagerly fetches a connection
// token, the route 403s (stripe_not_connected), and every enable attempt
// fails opaquely. This screen must gate the enable button up front, route
// every failure through describeTapToPayEnableFailure (never the raw SDK
// error), and offer a path to payment settings (the home tab's Stripe card).
//
// Harness pattern mirrors tap-to-pay-awareness.test.tsx: virtual host-string
// react-native mocks + require()d screen so the "@/..." mobile aliases stay
// out of the root tsc program.

import React from "react";

jest.mock(
  "react-native",
  () => ({
    View: "View",
    Text: "Text",
    ScrollView: "ScrollView",
    StyleSheet: {
      create: (styles: unknown) => styles,
      flatten: (style: unknown) => style,
    },
  }),
  { virtual: true }
);

// "Open payment settings" routes to the home tab, where the Stripe
// connect/status card lives.
const mockRouterPush = jest.fn();
jest.mock(
  "expo-router",
  () => ({ useRouter: () => ({ push: mockRouterPush }) }),
  { virtual: true }
);

jest.mock(
  "../../stores/session-store",
  () => ({
    useSessionStore: (selector: (state: { session: unknown }) => unknown) =>
      selector({ session: { pubkey: "pk-seller" } }),
  }),
  { virtual: true }
);

// Functional ActionButton (not a host string) so tests can press by label and
// read the disabled state; the cards/scroll chrome are shallow passthroughs.
jest.mock(
  "../../components/seller-ui",
  () => ({
    ActionButton: (props: {
      label: string;
      onPress?: () => void;
      disabled?: boolean;
      loading?: boolean;
      variant?: string;
    }) =>
      React.createElement(
        "Pressable",
        {
          onPress: props.onPress,
          accessibilityLabel: props.label,
          accessibilityState: { disabled: Boolean(props.disabled) },
        },
        React.createElement("Text", null, props.label)
      ),
    ScreenScrollView: (props: { children?: React.ReactNode }) =>
      React.createElement("ScrollView", null, props.children),
    ScreenTitle: (props: { title: string; description?: string }) =>
      React.createElement(
        React.Fragment,
        null,
        React.createElement("Text", null, props.title)
      ),
    SellerCard: (props: { children?: React.ReactNode }) =>
      React.createElement("View", null, props.children),
  }),
  { virtual: true }
);

// The provider wires the real Stripe Terminal SDK; here it passes children
// through, and the module stub below answers the hook.
jest.mock(
  "../../components/tap-to-pay-provider",
  () => ({
    TapToPayProvider: (props: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, props.children),
  }),
  { virtual: true }
);

jest.mock(
  "../../lib/pos-stripe-terminal",
  () => ({
    getStripeTerminalModule: () => ({
      useStripeTerminal: () => ({
        getConnectedReader: jest.fn(async () => null),
        discoverReaders: jest.fn(),
        getLocations: jest.fn(),
        connectReader: jest.fn(),
      }),
    }),
  }),
  { virtual: true }
);

const mockFetchPosPaymentMethods = jest.fn();
jest.mock(
  "../../lib/pos-api",
  () => ({
    fetchPosPaymentMethods: (...args: unknown[]) =>
      mockFetchPosPaymentMethods(...args),
  }),
  { virtual: true }
);

// Keep in sync with TAP_TO_PAY_CONNECT_STRIPE_MESSAGE in
// apps/mobile/lib/pos-tap-to-pay.ts — the pos-tap-to-pay suite asserts the
// real constant; here the module is mocked, so the literal must repeat.
const CONNECT_STRIPE_MESSAGE =
  "Connect a Stripe account with card charges to use Tap to Pay.";

const mockEnableTapToPay = jest.fn(
  async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true })
);
const mockDescribeFailure = jest.fn(
  async (): Promise<{ message: string; needsStripeConnect: boolean }> => ({
    message: "Could not enable Tap to Pay.",
    needsStripeConnect: false,
  })
);
jest.mock(
  "../../lib/pos-tap-to-pay",
  () => ({
    TAP_TO_PAY_CONNECT_STRIPE_MESSAGE: CONNECT_STRIPE_MESSAGE,
    awaitPendingTapToPayWarmup: jest.fn(async () => undefined),
    describeTapToPayEnableFailure: (...args: unknown[]) =>
      mockDescribeFailure(...args),
    enableTapToPay: (...args: unknown[]) => mockEnableTapToPay(...args),
  }),
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
  "../../components/tap-to-pay-education",
  () => ({ TapToPayEducationModal: "TapToPayEducationModal" }),
  { virtual: true }
);

jest.mock(
  "../../components/apple-pay-mark",
  () => ({ ApplePayMark: "ApplePayMark" }),
  { virtual: true }
);

// Stand-in, but asserted present below: Apple's rules require the legal
// disclaimer on every Tap to Pay screen (the awareness suite renders the real
// footer, so fidelity is covered there).
jest.mock(
  "../../components/tap-to-pay-disclaimer",
  () => ({ TapToPayDisclaimerFooter: "TapToPayDisclaimerFooter" }),
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

// Requiring (not importing) RNTL and the screen keeps the jest.mock
// registrations in effect and the "@/..." mobile aliases out of the root tsc
// program. Never destructure RNTL's `screen` placeholder — use the render()
// result's queries.
const { render, act, fireEvent } =
  require("@testing-library/react-native") as typeof import("@testing-library/react-native");

const Screen = (
  require("../../apps/mobile/app/(tabs)/settings/tap-to-pay") as {
    default: React.ComponentType;
  }
).default;

type RenderResult = Awaited<ReturnType<typeof render>>;
let app: RenderResult;

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

async function renderScreen() {
  app = await render(React.createElement(Screen));
  await flush();
  // Precondition for every assertion below: the screen actually rendered.
  expect(app.getByText("Tap to Pay on iPhone")).toBeTruthy();
}

describe("Tap to Pay settings screen Stripe-connect guidance", () => {
  beforeEach(() => {
    mockRouterPush.mockClear();
    mockFetchPosPaymentMethods.mockReset();
    mockEnableTapToPay.mockReset();
    mockEnableTapToPay.mockResolvedValue({ ok: true });
    mockDescribeFailure.mockReset();
    mockDescribeFailure.mockResolvedValue({
      message: "Could not enable Tap to Pay.",
      needsStripeConnect: false,
    });
  });

  it("gates the enable button and points to payment settings when card charges are off", async () => {
    mockFetchPosPaymentMethods.mockResolvedValue({
      stripe: { connected: false, chargesEnabled: false },
      square: { connected: false },
    });
    await renderScreen();
    expect(app.getByText(CONNECT_STRIPE_MESSAGE)).toBeTruthy();
    const enableButton = app.getByLabelText("Turn on Tap to Pay");
    expect(enableButton.props.accessibilityState?.disabled).toBe(true);
    await fireEvent.press(app.getByLabelText("Open payment settings"));
    expect(mockRouterPush).toHaveBeenCalledWith("/(tabs)");
    // The gated button must never start enablement.
    expect(mockEnableTapToPay).not.toHaveBeenCalled();
  });

  it("enables Tap to Pay normally when card charges are live", async () => {
    mockFetchPosPaymentMethods.mockResolvedValue({
      stripe: { connected: true, chargesEnabled: true },
      square: { connected: false },
    });
    await renderScreen();
    expect(app.queryByText(CONNECT_STRIPE_MESSAGE)).toBeNull();
    const enableButton = app.getByLabelText("Turn on Tap to Pay");
    expect(enableButton.props.accessibilityState?.disabled).toBe(false);
    await fireEvent.press(enableButton);
    await flush();
    expect(mockEnableTapToPay).toHaveBeenCalledTimes(1);
    expect(app.getByText("Tap to Pay is ready on this iPhone.")).toBeTruthy();
  });

  it("never shows the raw SDK init error verbatim", async () => {
    mockFetchPosPaymentMethods.mockResolvedValue({
      stripe: { connected: true, chargesEnabled: true },
      square: { connected: false },
    });
    mockEnableTapToPay.mockRejectedValue(
      new Error(
        "First initialize the Stripe Terminal SDK before performing any action"
      )
    );
    mockDescribeFailure.mockResolvedValue({
      message: "Tap to Pay is still starting up. Try again in a moment.",
      needsStripeConnect: false,
    });
    await renderScreen();
    await fireEvent.press(app.getByLabelText("Turn on Tap to Pay"));
    await flush();
    expect(mockDescribeFailure).toHaveBeenCalledTimes(1);
    expect(
      app.getByText("Tap to Pay is still starting up. Try again in a moment.")
    ).toBeTruthy();
    expect(
      app.queryByText(/First initialize the Stripe Terminal SDK/i)
    ).toBeNull();
  });

  it("offers the payment-settings path after a not-connected failure", async () => {
    mockFetchPosPaymentMethods.mockResolvedValue({
      stripe: { connected: true, chargesEnabled: true },
      square: { connected: false },
    });
    mockEnableTapToPay.mockResolvedValue({
      ok: false,
      error:
        "First initialize the Stripe Terminal SDK before performing any action",
    });
    mockDescribeFailure.mockResolvedValue({
      message: CONNECT_STRIPE_MESSAGE,
      needsStripeConnect: true,
    });
    await renderScreen();
    await fireEvent.press(app.getByLabelText("Turn on Tap to Pay"));
    await flush();
    expect(app.getByText(CONNECT_STRIPE_MESSAGE)).toBeTruthy();
    await fireEvent.press(app.getByLabelText("Open payment settings"));
    expect(mockRouterPush).toHaveBeenCalledWith("/(tabs)");
  });

  it("renders the required Tap to Pay legal disclaimer", async () => {
    mockFetchPosPaymentMethods.mockResolvedValue({
      stripe: { connected: true, chargesEnabled: true },
      square: { connected: false },
    });
    await renderScreen();
    const footers = app.container.queryAll(
      (node) => node.type === "TapToPayDisclaimerFooter"
    );
    expect(footers).toHaveLength(1);
  });
});
