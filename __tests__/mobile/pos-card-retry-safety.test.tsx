/** @jest-environment node */

// Wiring test for the double-charge guard in the PoS card checkout screen
// (apps/mobile/app/(tabs)/pos/card.tsx). The retry-safety rule itself is
// unit-tested in pos-card-sale.test.ts (canRetryCardPayment); this suite pins
// the SCREEN-level wiring a seller's card buyer depends on, so a refactor
// cannot silently regress it:
//   - an unknown post-confirm outcome (the charge may have succeeded) hides
//     "Try again", so the seller cannot start a second charge for the same
//     buyer until they reconcile in Stripe
//   - a retryable failure (e.g. not-approved — the card was read and
//     declined, nothing was captured) keeps "Try again", and pressing it
//     runs a fresh charge that can complete the sale
//
// The screen must consult canRetryCardPayment on every non-approved result:
// these tests route the screen's call through the REAL implementation (via a
// spy) so a dropped call, a dropped chargeBlocked set, or a changed button
// condition all fail here.
//
// Rendered with @testing-library/react-native using the mock pattern from
// pos-card-education-wiring.test.tsx (virtual "@/" mocks, host-string RN
// stand-ins, require-after-mocks).

import React from "react";

const asyncStorageStore = new Map<string, string>();

jest.mock(
  "@react-native-async-storage/async-storage",
  () => ({
    getItem: jest.fn(async (key: string) => asyncStorageStore.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      asyncStorageStore.set(key, value);
    }),
    removeItem: jest.fn(async (key: string) => {
      asyncStorageStore.delete(key);
    }),
  }),
  { virtual: true }
);

// Host-component stand-ins: the screen's behaviour lives in props/handlers,
// not in native rendering. StyleSheet.flatten must exist because
// @testing-library/react-native reads it internally. virtual: true so the
// mock also intercepts RNTL's own require("react-native").
jest.mock(
  "react-native",
  () => ({
    Alert: { alert: jest.fn() },
    Share: { share: jest.fn(async () => ({})) },
    StyleSheet: {
      create: (styles: unknown) => styles,
      flatten: (style: unknown) => style,
    },
    Text: "Text",
    View: "View",
  }),
  { virtual: true }
);

const mockRouter = { back: jest.fn(), replace: jest.fn() };

jest.mock("expo-router", () => ({ useRouter: () => mockRouter }), {
  virtual: true,
});

jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ setOptions: jest.fn(), dispatch: jest.fn() }),
  usePreventRemove: jest.fn(),
  // These scenarios never leave the card screen: always focused.
  useIsFocused: () => true,
}));

// Deterministic cart totals — the arithmetic itself is covered by the domain
// package's own tests.
jest.mock("@self-sown/domain", () => ({
  computePosCartTotals: jest.fn(() => ({
    total: 12,
    currency: "usd",
    itemCount: 1,
  })),
}));

// --- Stripe Terminal stub ---------------------------------------------------
const mockTerminal = {
  discoverReaders: jest.fn(),
  connectReader: jest.fn(),
  getConnectedReader: jest.fn(),
  getLocations: jest.fn(),
  retrievePaymentIntent: jest.fn(),
  collectPaymentMethod: jest.fn(),
  confirmPaymentIntent: jest.fn(),
  cancelCollectPaymentMethod: jest.fn(async () => ({})),
};

const mockTerminalModule = {
  useStripeTerminal: () => mockTerminal,
};

// --- Charge-pipeline mocks ---------------------------------------------------
const mockCreatePaymentIntent = jest.fn();
const mockExecuteCardPayment = jest.fn();
const mockFinalizePosSale = jest.fn();
const mockCompleteSale = jest.fn();
// Spy that defaults to the REAL canRetryCardPayment (installed in beforeEach)
// so these tests exercise the actual retry-safety rule AND can assert the
// screen consulted it with the exact payment result.
const mockCanRetryCardPayment = jest.fn();

// The screen imports "@/..." modules; the next/jest SWC transform rewrites
// those aliases with the ROOT tsconfig paths ("@/*" -> "./*"), so they arrive
// at jest's resolver as root-relative specifiers that don't exist. Register
// virtual mocks keyed at those same root-relative paths (as seen from this
// test file). See pos-card-education-wiring.test.tsx for the same pattern.
jest.mock(
  "../../lib/tap-to-pay-education",
  () =>
    jest.requireActual("../../apps/mobile/lib/tap-to-pay-education") as unknown,
  { virtual: true }
);

// The screen renders Apple's mark (react-native-svg); a host-string stand-in
// is enough for retry-safety assertions (fidelity is covered by
// apple-pay-marks.test.tsx).
jest.mock(
  "../../components/apple-pay-mark",
  () => ({ ApplePayMark: "ApplePayMark", ApplePayLogo: "ApplePayLogo" }),
  { virtual: true }
);

jest.mock(
  "../../lib/pos-stripe-terminal",
  () => ({ getStripeTerminalModule: () => mockTerminalModule }),
  { virtual: true }
);

jest.mock(
  "../../lib/pos-tap-to-pay",
  () => ({
    awaitPendingTapToPayWarmup: jest.fn(async () => undefined),
    describeTapToPayEnableFailure: jest.fn(async () => ({
      message: "Connect a Stripe account with card charges to use Tap to Pay.",
      needsStripeConnect: true,
    })),
    isSdkNotInitializedError: jest.fn(() => false),
  }),
  { virtual: true }
);

jest.mock(
  "../../lib/pos-api",
  () => ({
    createStripeTerminalPaymentIntent: (...args: unknown[]) =>
      mockCreatePaymentIntent(...args),
  }),
  { virtual: true }
);

jest.mock(
  "../../lib/pos-card-sale",
  () => ({
    canRetryCardPayment: (...args: unknown[]) =>
      mockCanRetryCardPayment(...args),
    executeCardPayment: (...args: unknown[]) => mockExecuteCardPayment(...args),
  }),
  { virtual: true }
);

jest.mock(
  "../../lib/pos-fx",
  () => ({
    formatPosAmount: (total: number) => `$${total.toFixed(2)}`,
    toSmallestUnit: (total: number) => Math.round(total * 100),
  }),
  { virtual: true }
);

jest.mock(
  "../../lib/pos-notifications",
  () => ({
    notifyCardPaymentApproved: jest.fn(async () => undefined),
    notifyCardPaymentNotApproved: jest.fn(async () => undefined),
  }),
  { virtual: true }
);

// The real store: focused scenarios never set an unseen outcome, but the
// screen subscribes to it unconditionally.
jest.mock(
  "../../lib/pos-outcome-store",
  () =>
    jest.requireActual("../../apps/mobile/lib/pos-outcome-store") as unknown,
  { virtual: true }
);

jest.mock(
  "../../lib/pos-receipt",
  () => ({
    buildPosReceiptLines: jest.fn(() => []),
    formatDeclinedCardReceiptText: jest.fn(() => "declined receipt"),
  }),
  { virtual: true }
);

jest.mock(
  "../../lib/pos-sale",
  () => ({
    finalizePosSale: (...args: unknown[]) => mockFinalizePosSale(...args),
  }),
  { virtual: true }
);

jest.mock(
  "../../lib/error-utils",
  () => ({
    getErrorMessage: (error: unknown, fallback: string) =>
      error instanceof Error && error.message ? error.message : fallback,
  }),
  { virtual: true }
);

jest.mock(
  "../../stores/session-store",
  () => ({
    useSessionStore: (selector: (state: unknown) => unknown) =>
      selector({ session: { pubkey: "pk-seller" } }),
  }),
  { virtual: true }
);

jest.mock(
  "../../lib/pos-cart-store",
  () => ({
    usePosCartStore: (selector: (state: unknown) => unknown) =>
      selector({
        lines: [{ lineId: "line-1" }],
        note: "",
        buyerEmail: "",
        activeSaleId: "sale-1",
        completeSale: (...args: unknown[]) => mockCompleteSale(...args),
      }),
  }),
  { virtual: true }
);

jest.mock(
  "../../components/seller-ui",
  () => ({
    ActionButton: "ActionButton",
    ScreenScrollView: "ScreenScrollView",
    ScreenTitle: "ScreenTitle",
    SellerCard: "SellerCard",
  }),
  { virtual: true }
);

jest.mock(
  "../../components/tap-to-pay-education",
  () => ({
    TapToPayEducationModal: (props: { visible: boolean; onDone: () => void }) =>
      React.createElement("TapToPayEducationModal", props),
  }),
  { virtual: true }
);

jest.mock(
  "../../theme/tokens",
  () => ({
    sellerFonts: { regular: "Test-Regular", semibold: "Test-Semibold" },
    sellerThemeTokens: {
      danger: "#ff0000",
      mutedText: "#888888",
      text: "#111111",
    },
  }),
  { virtual: true }
);

import { markTapToPayEducationSeen } from "../../apps/mobile/lib/tap-to-pay-education";

// Requiring (not importing) @testing-library/react-native keeps the
// jest.mock("react-native", ...) registration above in effect when RNTL
// loads: the next/jest SWC transform does NOT hoist jest.mock calls above
// static ESM imports, and RNTL requires the real (ESM, untransformed)
// react-native at module load, which would crash before the mock registers.
// NOTE: RNTL v14's exported `screen` is a placeholder proxy that render()
// REPLACES, so never destructure it — use the render() result's queries.
const { render, act, fireEvent } =
  require("@testing-library/react-native") as typeof import("@testing-library/react-native");

// Requiring (not importing) the screen keeps its "@/..." mobile aliases out
// of the root tsc program: the web tsconfig maps "@/*" to the repo root,
// where the mobile modules don't exist, so a static import would fail the
// project typecheck. Jest resolves the module at runtime against the mocks
// registered above.
const { default: PosCardScreen } =
  require("../../apps/mobile/app/(tabs)/pos/card") as {
    default: React.ComponentType;
  };

type RenderResult = Awaited<ReturnType<typeof render>>;

// The host-node type `container.queryAll` returns (see
// pos-card-education-wiring.test.tsx for why this is derived, not imported).
type HostNode = RenderResult["container"];

// The current render, refreshed by every renderScreen call. RNTL's auto
// cleanup unmounts after each test, so tests only ever see their own tree.
let app: RenderResult;

function hostNodesOfType(name: string): HostNode[] {
  return app.container.queryAll((node) => node.type === name);
}

function findButton(label: string): HostNode | undefined {
  return hostNodesOfType("ActionButton").find((b) => b.props.label === label);
}

async function flushMicrotasks() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

async function renderScreen() {
  app = await render(React.createElement(PosCardScreen));
}

async function pressButton(label: string) {
  const button = findButton(label);
  expect(button).toBeDefined();
  await fireEvent.press(button!);
  await flushMicrotasks();
}

beforeEach(() => {
  asyncStorageStore.clear();
  jest.clearAllMocks();

  // Educated seller on a live reader connection: every scenario goes
  // straight to the charge (the education pause has its own wiring suite).
  return markTapToPayEducationSeen("pk-seller").then(() => {
    mockTerminal.getConnectedReader.mockResolvedValue({ id: "reader-live" });
    mockTerminal.discoverReaders.mockResolvedValue({});
    mockTerminal.getLocations.mockResolvedValue({
      locations: [{ id: "loc-1" }],
    });
    mockTerminal.connectReader.mockResolvedValue({});

    mockCreatePaymentIntent.mockResolvedValue({
      clientSecret: "pi_secret_1",
      paymentIntentId: "pi_1",
    });
    mockFinalizePosSale.mockResolvedValue({ saleId: "sale-1" });

    // The screen's retry decision uses the REAL rule; the spy only observes.
    const actual = jest.requireActual(
      "../../apps/mobile/lib/pos-card-sale"
    ) as typeof import("../../apps/mobile/lib/pos-card-sale");
    mockCanRetryCardPayment.mockImplementation(actual.canRetryCardPayment);
  });
});

describe("PoS card checkout retry-safety wiring", () => {
  it("an unknown post-confirm outcome hides Try again, so no second charge can be started", async () => {
    // The confirm errored and Stripe's status could not be reconciled: the
    // buyer's card may already be charged. Retrying would double-charge.
    const unknownOutcome = {
      kind: "unknown-outcome",
      message:
        "The reader didn't confirm the result. Check your Stripe Dashboard for this payment before retrying, so the customer isn't charged twice.",
    };
    mockExecuteCardPayment.mockResolvedValue(unknownOutcome);

    await renderScreen();
    await pressButton("Charge $12.00");

    // The charge ran once and failed with an ambiguous outcome; the sale was
    // NOT recorded and no success navigation happened.
    expect(mockCreatePaymentIntent).toHaveBeenCalledTimes(1);
    expect(mockExecuteCardPayment).toHaveBeenCalledTimes(1);
    expect(mockFinalizePosSale).not.toHaveBeenCalled();
    expect(mockCompleteSale).not.toHaveBeenCalled();
    expect(mockRouter.replace).not.toHaveBeenCalled();

    // The screen consulted the retry-safety rule with the exact result...
    expect(mockCanRetryCardPayment).toHaveBeenCalledWith(unknownOutcome);

    // ...and the outcome screen offers NO way to start a second charge:
    // neither the retry button nor a fresh charge button is rendered.
    expect(findButton("Try again")).toBeUndefined();
    expect(findButton("Charge $12.00")).toBeUndefined();
    // An unknown outcome is not a decline: no declined-receipt share either.
    expect(findButton("Share declined receipt")).toBeUndefined();
    // The only way out is back to the sale.
    expect(findButton("Back to sale")).toBeDefined();

    // The error tells the seller to reconcile in Stripe before retrying.
    const errorText = hostNodesOfType("Text").find(
      (node) => node.props.children === unknownOutcome.message
    );
    expect(errorText).toBeDefined();

    // A stray re-render later, the retry affordance must still be absent and
    // no second payment intent may have been created.
    await flushMicrotasks();
    expect(findButton("Try again")).toBeUndefined();
    expect(mockCreatePaymentIntent).toHaveBeenCalledTimes(1);
    expect(mockExecuteCardPayment).toHaveBeenCalledTimes(1);
  });

  it("a retryable not-approved failure keeps Try again, and the retry completes the sale", async () => {
    // The card was read and declined — nothing was captured, so charging
    // again is safe.
    const notApproved = {
      kind: "not-approved",
      message: "The card was declined.",
    };
    mockExecuteCardPayment.mockResolvedValueOnce(notApproved);

    await renderScreen();
    await pressButton("Charge $12.00");

    // First attempt declined: error screen WITH the retry affordance.
    expect(mockCreatePaymentIntent).toHaveBeenCalledTimes(1);
    expect(mockCanRetryCardPayment).toHaveBeenCalledWith(notApproved);
    expect(mockFinalizePosSale).not.toHaveBeenCalled();
    expect(findButton("Try again")).toBeDefined();
    // The decline receipt share stays available (Apple Tap to Pay 5.10).
    expect(findButton("Share declined receipt")).toBeDefined();

    // The seller retries (e.g. the buyer presents a different card): the
    // second attempt runs a FRESH payment intent and can succeed.
    mockExecuteCardPayment.mockResolvedValueOnce({ kind: "approved" });
    mockCreatePaymentIntent.mockResolvedValueOnce({
      clientSecret: "pi_secret_2",
      paymentIntentId: "pi_2",
    });

    await pressButton("Try again");

    expect(mockCreatePaymentIntent).toHaveBeenCalledTimes(2);
    expect(mockExecuteCardPayment).toHaveBeenCalledTimes(2);
    // The retried charge finalizes exactly once and navigates to success.
    expect(mockFinalizePosSale).toHaveBeenCalledTimes(1);
    expect(mockCompleteSale).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledWith("/(tabs)/pos/success");
  });

  it("a retryable pre-card failure keeps Try again", async () => {
    // The intent could not even be loaded: the buyer's card was never
    // involved, so retrying is safe.
    const failed = {
      kind: "failed",
      message: "Could not load the card payment.",
    };
    mockExecuteCardPayment.mockResolvedValue(failed);

    await renderScreen();
    await pressButton("Charge $12.00");

    expect(mockCanRetryCardPayment).toHaveBeenCalledWith(failed);
    expect(mockFinalizePosSale).not.toHaveBeenCalled();
    expect(findButton("Try again")).toBeDefined();
  });
});
