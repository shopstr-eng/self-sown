/** @jest-environment node */

// Wiring test for the tab-switch-mid-charge outcome contract in the PoS card
// checkout screen (apps/mobile/app/(tabs)/pos/card.tsx). Tab switches do NOT
// unmount the screen and the charge-in-flight navigation block only covers
// back/removal, so a seller who taps another tab mid-charge has the sale
// resolve on a screen nobody is watching. This suite pins the behavior a
// seller's card buyer depends on:
//   - a charge that resolves APPROVED while the screen is unfocused does NOT
//     fire router.replace behind the other tab; it badges the Sell tab (via
//     the real outcome store), fires the approved-charge notification with
//     the charged amount, and defers the success navigation to refocus
//   - a charge that resolves in FAILURE while unfocused badges the Sell tab
//     and keeps the error state waiting for the seller's return
//   - a charge that resolves while FOCUSED behaves exactly as before: one
//     immediate success navigation, no badge, no approved notification
//   - a seller who returns mid-charge (focus flips back before resolution)
//     gets the immediate focused path
//
// Rendered with @testing-library/react-native using the mock pattern from
// pos-card-retry-safety.test.tsx (virtual "@/" mocks, host-string RN
// stand-ins, require-after-mocks). Focus is driven by a mutable flag behind
// the useIsFocused mock plus RNTL's update() to re-render.

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

// Focus is scenario-controlled: tests flip mockFocused and re-render to
// simulate the seller leaving and returning to the Sell tab.
let mockFocused = true;

jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ setOptions: jest.fn(), dispatch: jest.fn() }),
  usePreventRemove: jest.fn(),
  useIsFocused: () => mockFocused,
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
const mockNotifyApproved = jest.fn(async (..._args: unknown[]) => undefined);
const mockNotifyNotApproved = jest.fn(async (..._args: unknown[]) => undefined);

// The screen imports "@/..." modules; the next/jest SWC transform rewrites
// those aliases with the ROOT tsconfig paths ("@/*" -> "./*"), so they arrive
// at jest's resolver as root-relative specifiers that don't exist. Register
// virtual mocks keyed at those same root-relative paths (as seen from this
// test file). See pos-card-retry-safety.test.tsx for the same pattern.
jest.mock(
  "../../lib/tap-to-pay-education",
  () =>
    jest.requireActual("../../apps/mobile/lib/tap-to-pay-education") as unknown,
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
    createStripeTerminalConnectionToken: jest.fn(async () => ({
      secret: "pst_test",
    })),
    createStripeTerminalPaymentIntent: (...args: unknown[]) =>
      mockCreatePaymentIntent(...args),
  }),
  { virtual: true }
);

jest.mock(
  "../../lib/pos-card-sale",
  () => {
    const actual = jest.requireActual(
      "../../apps/mobile/lib/pos-card-sale"
    ) as typeof import("../../apps/mobile/lib/pos-card-sale");
    return {
      ...actual,
      executeCardPayment: (...args: unknown[]) =>
        mockExecuteCardPayment(...args),
    };
  },
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
    notifyCardPaymentApproved: (...args: unknown[]) =>
      mockNotifyApproved(...args),
    notifyCardPaymentNotApproved: (...args: unknown[]) =>
      mockNotifyNotApproved(...args),
  }),
  { virtual: true }
);

// The REAL outcome store: the badge contract under test lives in its state,
// so a refactor that drops the set/clear calls fails here.
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
  "../../components/apple-pay-mark",
  () => ({ ApplePayMark: "ApplePayMark" }),
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
import { usePosOutcomeStore } from "../../apps/mobile/lib/pos-outcome-store";

// Requiring (not importing) @testing-library/react-native keeps the
// jest.mock("react-native", ...) registration above in effect when RNTL
// loads: the next/jest SWC transform does NOT hoist jest.mock calls above
// static ESM imports, and RNTL requires the real (ESM, untransformed)
// react-native at module load, which would crash before the mock registers.
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
type HostNode = RenderResult["container"];

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

// Simulates the seller tapping back to the Sell tab: useIsFocused flips and
// the screen re-renders, which runs the refocus effect.
async function refocusScreen() {
  mockFocused = true;
  await act(async () => {
    app.rerender(React.createElement(PosCardScreen));
  });
  await flushMicrotasks();
}

beforeEach(() => {
  asyncStorageStore.clear();
  jest.clearAllMocks();
  mockFocused = true;
  usePosOutcomeStore.getState().clearUnseenOutcome();

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
  });
});

describe("PoS card checkout tab-switch outcome wiring", () => {
  it("an approved charge while unfocused signals the outcome and defers the success navigation to refocus", async () => {
    mockFocused = false;
    mockExecuteCardPayment.mockResolvedValue({ kind: "approved" });

    await renderScreen();
    await pressButton("Charge $12.00");

    // The sale is still recorded even though nobody is watching the screen.
    expect(mockFinalizePosSale).toHaveBeenCalledTimes(1);
    expect(mockCompleteSale).toHaveBeenCalledTimes(1);

    // No navigation fires behind the tab the seller is looking at.
    expect(mockRouter.replace).not.toHaveBeenCalled();

    // The outcome is signaled: approved-charge notification with the charged
    // amount + the unseen-outcome store entry the Sell tab badges from.
    expect(mockNotifyApproved).toHaveBeenCalledWith({ amountText: "$12.00" });
    expect(usePosOutcomeStore.getState().unseenOutcome).toEqual({
      approved: true,
      amountText: "$12.00",
    });

    // Returning to the Sell tab runs the deferred success navigation exactly
    // once and clears the badge signal.
    await refocusScreen();
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledWith("/(tabs)/pos/success");
    expect(usePosOutcomeStore.getState().unseenOutcome).toBeNull();

    // Later re-renders never repeat the navigation.
    await flushMicrotasks();
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
  });

  it("an approved charge while focused navigates immediately with no badge and no notification", async () => {
    mockFocused = true;
    mockExecuteCardPayment.mockResolvedValue({ kind: "approved" });

    await renderScreen();
    await pressButton("Charge $12.00");

    expect(mockCompleteSale).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledWith("/(tabs)/pos/success");
    expect(mockNotifyApproved).not.toHaveBeenCalled();
    expect(usePosOutcomeStore.getState().unseenOutcome).toBeNull();

    // No double navigation on later re-renders.
    await flushMicrotasks();
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
  });

  it("a declined charge while unfocused badges the Sell tab and shows the error state on return", async () => {
    mockFocused = false;
    const notApproved = {
      kind: "not-approved",
      message: "The card was declined.",
    };
    mockExecuteCardPayment.mockResolvedValue(notApproved);

    await renderScreen();
    await pressButton("Charge $12.00");

    // The Apple 5.12 decline notification still fires, and the Sell tab is
    // badged with the failed outcome. No success navigation happened.
    expect(mockNotifyNotApproved).toHaveBeenCalledWith({
      amountText: "$12.00",
    });
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(usePosOutcomeStore.getState().unseenOutcome).toEqual({
      approved: false,
      amountText: "$12.00",
      message: "The card was declined.",
    });

    // Returning to the Sell tab shows the resolved error state (with the
    // retry affordance for a retryable decline) and clears the badge.
    await refocusScreen();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(findButton("Try again")).toBeDefined();
    const errorText = hostNodesOfType("Text").find(
      (node) => node.props.children === "The card was declined."
    );
    expect(errorText).toBeDefined();
    expect(usePosOutcomeStore.getState().unseenOutcome).toBeNull();
  });

  it("a tab switch during the recording step still defers the success navigation", async () => {
    // Approved while FOCUSED, but the seller switches tabs while
    // finalizePosSale is still recording the sale: focus must be sampled at
    // completion, or the replace fires behind the other tab.
    mockFocused = true;
    mockExecuteCardPayment.mockResolvedValue({ kind: "approved" });
    let resolveFinalize: (value: { saleId: string }) => void = () => {};
    mockFinalizePosSale.mockReturnValue(
      new Promise((resolve) => {
        resolveFinalize = resolve;
      })
    );

    await renderScreen();
    await pressButton("Charge $12.00");
    expect(mockFinalizePosSale).toHaveBeenCalledTimes(1);

    // The seller switches away mid-recording.
    mockFocused = false;
    await act(async () => {
      app.rerender(React.createElement(PosCardScreen));
    });
    await flushMicrotasks();

    resolveFinalize({ saleId: "sale-1" });
    await flushMicrotasks();

    // The sale is recorded, but no navigation fired behind the other tab:
    // the outcome is signaled and the success navigation is deferred.
    expect(mockCompleteSale).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(mockNotifyApproved).toHaveBeenCalledWith({ amountText: "$12.00" });
    expect(usePosOutcomeStore.getState().unseenOutcome).toEqual({
      approved: true,
      amountText: "$12.00",
    });

    await refocusScreen();
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledWith("/(tabs)/pos/success");
    expect(usePosOutcomeStore.getState().unseenOutcome).toBeNull();
  });

  it("a refocus during the recording step does not navigate before the sale is recorded", async () => {
    // Approved while UNFOCUSED, and the seller returns while finalizePosSale
    // is still recording: the success navigation must wait for the recording
    // to finish, then take the immediate focused path.
    mockFocused = false;
    mockExecuteCardPayment.mockResolvedValue({ kind: "approved" });
    let resolveFinalize: (value: { saleId: string }) => void = () => {};
    mockFinalizePosSale.mockReturnValue(
      new Promise((resolve) => {
        resolveFinalize = resolve;
      })
    );

    await renderScreen();
    await pressButton("Charge $12.00");
    expect(mockFinalizePosSale).toHaveBeenCalledTimes(1);

    // The seller returns mid-recording: nothing navigates yet (the sale is
    // not recorded) and no badge was armed.
    await refocusScreen();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(mockCompleteSale).not.toHaveBeenCalled();
    expect(usePosOutcomeStore.getState().unseenOutcome).toBeNull();

    // Recording finishes with the seller watching: immediate navigation, no
    // badge, no notification.
    resolveFinalize({ saleId: "sale-1" });
    await flushMicrotasks();
    expect(mockCompleteSale).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledWith("/(tabs)/pos/success");
    expect(mockNotifyApproved).not.toHaveBeenCalled();
    expect(usePosOutcomeStore.getState().unseenOutcome).toBeNull();
  });

  it("a recording failure while unfocused badges the failure and never navigates to success", async () => {
    // The card was charged but recording the sale failed: the deferred
    // marker must NOT stay armed, or the error screen is blanked and refocus
    // would navigate to success for an unrecorded sale.
    mockFocused = false;
    mockExecuteCardPayment.mockResolvedValue({ kind: "approved" });
    mockFinalizePosSale.mockRejectedValue(
      new Error("Could not record the sale.")
    );

    await renderScreen();
    await pressButton("Charge $12.00");

    expect(mockCompleteSale).not.toHaveBeenCalled();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(mockNotifyApproved).not.toHaveBeenCalled();
    expect(usePosOutcomeStore.getState().unseenOutcome).toEqual({
      approved: false,
      amountText: "$12.00",
      message: "Could not record the sale.",
    });

    // Returning to the Sell tab shows the error state — no success
    // navigation for a sale that was never recorded.
    await refocusScreen();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    const errorText = hostNodesOfType("Text").find(
      (node) => node.props.children === "Could not record the sale."
    );
    expect(errorText).toBeDefined();
    expect(usePosOutcomeStore.getState().unseenOutcome).toBeNull();
  });

  it("a seller who returns mid-charge gets the immediate focused path at resolution", async () => {
    mockFocused = false;
    let resolvePayment: (value: { kind: string }) => void = () => {};
    mockExecuteCardPayment.mockReturnValue(
      new Promise((resolve) => {
        resolvePayment = resolve;
      })
    );

    await renderScreen();
    await pressButton("Charge $12.00");

    // The charge is still in flight; the seller returns to the Sell tab
    // before it resolves.
    expect(mockExecuteCardPayment).toHaveBeenCalledTimes(1);
    await refocusScreen();

    resolvePayment({ kind: "approved" });
    await flushMicrotasks();

    // Focused at resolution: the sale finalizes, the success navigation
    // fires immediately, and nothing is badged or notified.
    expect(mockFinalizePosSale).toHaveBeenCalledTimes(1);
    expect(mockCompleteSale).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledWith("/(tabs)/pos/success");
    expect(mockNotifyApproved).not.toHaveBeenCalled();
    expect(usePosOutcomeStore.getState().unseenOutcome).toBeNull();
  });
});
