/** @jest-environment node */

// Wiring test for the tab-switch-mid-payment outcome contract in the PoS
// Lightning checkout screen (apps/mobile/app/(tabs)/pos/lightning.tsx).
// Mirrors pos-card-tab-switch.test.tsx: tab switches do NOT unmount the
// screen, so a seller who taps another tab while waiting for the buyer's
// payment has the invoice resolve on a screen nobody is watching. This
// suite pins the behavior a seller's Lightning buyer depends on:
//   - a payment detected while the screen is unfocused does NOT fire
//     router.replace behind the other tab; it badges the Sell tab (via the
//     real outcome store) and defers the success navigation to refocus
//   - a failure (invoice timeout, recording failure) while unfocused badges
//     the Sell tab and keeps the error state waiting for the seller's return
//   - a payment detected while FOCUSED behaves exactly as before: one
//     immediate success navigation, no badge
//   - a seller who returns while the invoice is still unpaid gets the
//     immediate focused path at resolution
//
// Focus is driven by a mutable flag behind the useIsFocused mock plus
// RNTL's rerender(); the invoice poll is driven by jest fake timers
// advanced past POLL_INTERVAL_MS (3s) and the invoice timeout (10min).

import React from "react";

// Host-component stand-ins: the screen's behaviour lives in props/handlers,
// not in native rendering. StyleSheet.flatten must exist because
// @testing-library/react-native reads it internally. virtual: true so the
// mock also intercepts RNTL's own require("react-native").
jest.mock(
  "react-native",
  () => ({
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
  useIsFocused: () => mockFocused,
}));

jest.mock(
  "react-native-qrcode-svg",
  () => ({ __esModule: true, default: "QRCode" }),
  { virtual: true }
);

// Deterministic cart totals — the arithmetic itself is covered by the
// domain package's own tests.
jest.mock("@self-sown/domain", () => ({
  computePosCartTotals: jest.fn(() => ({
    total: 12,
    currency: "usd",
    itemCount: 1,
  })),
}));

// --- Lightning pipeline mocks (NWC path) -----------------------------------
const mockLoadNwcConnection = jest.fn();
const mockLookupInvoicePaid = jest.fn();
const mockMakeInvoice = jest.fn();

// The screen imports "@/..." modules; the next/jest SWC transform rewrites
// those aliases with the ROOT tsconfig paths ("@/*" -> "./*"), so they
// arrive at jest's resolver as root-relative specifiers that don't exist.
// Register virtual mocks keyed at those same root-relative paths (as seen
// from this test file). See pos-card-tab-switch.test.tsx for the pattern.
jest.mock(
  "../../lib/nwc",
  () => ({
    loadNwcConnection: (...args: unknown[]) => mockLoadNwcConnection(...args),
    lookupNwcInvoicePaid: (...args: unknown[]) =>
      mockLookupInvoicePaid(...args),
    makeNwcInvoice: (...args: unknown[]) => mockMakeInvoice(...args),
    parseNwcConnectionString: jest.fn(() => ({ walletPubkey: "wallet-pk" })),
    resolveNwcEncryption: jest.fn(async () => "nip44"),
  }),
  { virtual: true }
);

jest.mock(
  "../../lib/pos-cashu",
  () => ({
    checkCashuQuotePaid: jest.fn(async () => false),
    claimCashuQuote: jest.fn(async () => undefined),
    createCashuMintInvoice: jest.fn(),
    recordPendingCashuQuote: jest.fn(async () => undefined),
  }),
  { virtual: true }
);

jest.mock(
  "../../lib/account-settings",
  () => ({
    loadAccountPreferences: jest.fn(async () => ({ mints: [] })),
  }),
  { virtual: true }
);

const mockFinalizePosSale = jest.fn();
const mockCompleteSale = jest.fn();

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
  "../../lib/pos-fx",
  () => ({
    fiatToSats: jest.fn(async () => 42000),
    formatPosAmount: (total: number) => `$${total.toFixed(2)}`,
    isSatsCurrency: () => false,
  }),
  { virtual: true }
);

jest.mock(
  "../../lib/pos-receipt",
  () => ({ buildPosReceiptLines: jest.fn(() => []) }),
  { virtual: true }
);

jest.mock(
  "../../lib/pos-sale",
  () => ({
    finalizePosSale: (...args: unknown[]) => mockFinalizePosSale(...args),
  }),
  { virtual: true }
);

// The REAL outcome store: the badge contract under test lives in its state,
// so a refactor that drops the set/clear calls fails here.
jest.mock(
  "../../lib/pos-card-outcome-store",
  () =>
    jest.requireActual(
      "../../apps/mobile/lib/pos-card-outcome-store"
    ) as unknown,
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
  "../../components/loading-screen",
  () => ({ __esModule: true, default: "LoadingScreen" }),
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

import { usePosCardOutcomeStore } from "../../apps/mobile/lib/pos-card-outcome-store";

// Requiring (not importing) @testing-library/react-native keeps the
// jest.mock("react-native", ...) registration above in effect when RNTL
// loads: the next/jest SWC transform does NOT hoist jest.mock calls above
// static ESM imports, and RNTL requires the real (ESM, untransformed)
// react-native at module load, which would crash before the mock registers.
const { render, act } =
  require("@testing-library/react-native") as typeof import("@testing-library/react-native");

// Requiring (not importing) the screen keeps its "@/..." mobile aliases out
// of the root tsc program: the web tsconfig maps "@/*" to the repo root,
// where the mobile modules don't exist, so a static import would fail the
// project typecheck. Jest resolves the module at runtime against the mocks
// registered above.
const { default: PosLightningScreen } =
  require("../../apps/mobile/app/(tabs)/pos/lightning") as {
    default: React.ComponentType;
  };

type RenderResult = Awaited<ReturnType<typeof render>>;
type HostNode = RenderResult["container"];

const POLL_INTERVAL_MS = 3_000;
const INVOICE_TIMEOUT_MS = 10 * 60 * 1000;

let app: RenderResult;

function hostNodesOfType(name: string): HostNode[] {
  return app.container.queryAll((node) => node.type === name);
}

async function flushMicrotasks() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

async function renderScreen() {
  app = await render(React.createElement(PosLightningScreen));
}

// Runs one poll tick and lets the payment-detection promise chain settle.
async function advanceOnePollTick() {
  await act(async () => {
    jest.advanceTimersByTime(POLL_INTERVAL_MS);
  });
  await flushMicrotasks();
}

// Simulates the seller tapping back to the Sell tab: useIsFocused flips and
// the screen re-renders, which runs the refocus effect.
async function refocusScreen() {
  mockFocused = true;
  await act(async () => {
    app.rerender(React.createElement(PosLightningScreen));
  });
  await flushMicrotasks();
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockFocused = true;
  usePosCardOutcomeStore.getState().clearUnseenOutcome();

  // Seller with an NWC wallet; the invoice is created up front and each
  // scenario controls when (or whether) the wallet reports it paid.
  mockLoadNwcConnection.mockResolvedValue({
    connectionString: "nostr+walletconnect://wallet-pk?relay=wss://r",
    info: null,
  });
  mockMakeInvoice.mockResolvedValue({
    invoice: "lnbc1testinvoice",
    paymentHash: "hash-1",
  });
  mockLookupInvoicePaid.mockResolvedValue({ paid: false });
  mockFinalizePosSale.mockResolvedValue({ saleId: "sale-1" });
});

afterEach(() => {
  jest.useRealTimers();
});

describe("PoS Lightning checkout tab-switch outcome wiring", () => {
  it("a payment detected while unfocused signals the outcome and defers the success navigation to refocus", async () => {
    mockFocused = false;

    await renderScreen();
    await flushMicrotasks();

    // The buyer pays the invoice while the seller is on another tab.
    mockLookupInvoicePaid.mockResolvedValue({
      paid: true,
      preimage: "preimage-1",
    });
    await advanceOnePollTick();

    // The sale is still recorded even though nobody is watching the screen.
    expect(mockFinalizePosSale).toHaveBeenCalledTimes(1);
    expect(mockCompleteSale).toHaveBeenCalledTimes(1);

    // No navigation fires behind the tab the seller is looking at.
    expect(mockRouter.replace).not.toHaveBeenCalled();

    // The outcome is signaled via the unseen-outcome store entry the Sell
    // tab badges from.
    expect(usePosCardOutcomeStore.getState().unseenOutcome).toEqual({
      approved: true,
      amountText: "$12.00",
    });

    // Returning to the Sell tab runs the deferred success navigation
    // exactly once and clears the badge signal.
    await refocusScreen();
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledWith("/(tabs)/pos/success");
    expect(usePosCardOutcomeStore.getState().unseenOutcome).toBeNull();

    // Later re-renders never repeat the navigation.
    await flushMicrotasks();
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
  });

  it("a payment detected while focused navigates immediately with no badge", async () => {
    mockFocused = true;

    await renderScreen();
    await flushMicrotasks();

    mockLookupInvoicePaid.mockResolvedValue({
      paid: true,
      preimage: "preimage-1",
    });
    await advanceOnePollTick();

    expect(mockCompleteSale).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledWith("/(tabs)/pos/success");
    expect(usePosCardOutcomeStore.getState().unseenOutcome).toBeNull();

    // No double navigation on later re-renders.
    await flushMicrotasks();
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
  });

  it("an invoice that expires while unfocused badges the Sell tab and shows the error state on return", async () => {
    mockFocused = false;

    await renderScreen();
    await flushMicrotasks();

    // The invoice never gets paid; the 10-minute timeout fires while the
    // seller is on another tab.
    await act(async () => {
      jest.advanceTimersByTime(INVOICE_TIMEOUT_MS);
    });
    await flushMicrotasks();

    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(usePosCardOutcomeStore.getState().unseenOutcome).toEqual({
      approved: false,
      amountText: "$12.00",
      message: "The invoice expired without payment.",
    });

    // Returning to the Sell tab shows the resolved error state (with the
    // retry affordance) and clears the badge; no success navigation fires.
    await refocusScreen();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(
      hostNodesOfType("ActionButton").find(
        (node) => node.props.label === "Try again"
      )
    ).toBeDefined();
    const errorText = hostNodesOfType("Text").find(
      (node) => node.props.children === "The invoice expired without payment."
    );
    expect(errorText).toBeDefined();
    expect(usePosCardOutcomeStore.getState().unseenOutcome).toBeNull();
  });

  it("a recording failure while unfocused badges the failure and never navigates to success", async () => {
    // The buyer paid but recording the sale failed: the deferred marker
    // must NOT stay armed, or refocus would navigate to success for a sale
    // that was never recorded.
    mockFocused = false;
    mockFinalizePosSale.mockRejectedValue(
      new Error("Could not record the sale.")
    );

    await renderScreen();
    await flushMicrotasks();

    mockLookupInvoicePaid.mockResolvedValue({
      paid: true,
      preimage: "preimage-1",
    });
    await advanceOnePollTick();

    expect(mockCompleteSale).not.toHaveBeenCalled();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(usePosCardOutcomeStore.getState().unseenOutcome).toEqual({
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
    expect(usePosCardOutcomeStore.getState().unseenOutcome).toBeNull();
  });

  it("a seller who returns while the invoice is unpaid gets the immediate focused path at resolution", async () => {
    mockFocused = false;

    await renderScreen();
    await flushMicrotasks();

    // The invoice is still unpaid; the seller returns to the Sell tab
    // before the buyer pays.
    await refocusScreen();
    expect(usePosCardOutcomeStore.getState().unseenOutcome).toBeNull();

    mockLookupInvoicePaid.mockResolvedValue({
      paid: true,
      preimage: "preimage-1",
    });
    await advanceOnePollTick();

    // Focused at resolution: the sale finalizes, the success navigation
    // fires immediately, and nothing is badged.
    expect(mockFinalizePosSale).toHaveBeenCalledTimes(1);
    expect(mockCompleteSale).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledWith("/(tabs)/pos/success");
    expect(usePosCardOutcomeStore.getState().unseenOutcome).toBeNull();
  });
});
