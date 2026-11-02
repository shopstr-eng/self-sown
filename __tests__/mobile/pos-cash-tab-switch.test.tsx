/** @jest-environment node */

// Wiring test for the tab-switch-mid-recording outcome contract in the PoS
// cart screen's cash completion (apps/mobile/app/(tabs)/pos/cart.tsx). Tab
// switches do NOT unmount the screen, so a seller who taps another tab while
// finalizePosSale is recording has the sale resolve on a screen nobody is
// watching. This suite pins the same contract as pos-card-tab-switch.test
// .tsx, on the shorter cash window:
//   - a cash sale whose recording completes while the screen is unfocused
//     does NOT fire router.replace behind the other tab; it badges the Sell
//     tab (via the real outcome store) and defers the success navigation to
//     refocus
//   - a recording FAILURE while unfocused badges the Sell tab and keeps the
//     error state waiting for the seller's return
//   - a sale that completes while FOCUSED behaves exactly as before: one
//     immediate success navigation, no badge
//   - focus is sampled AT COMPLETION: a tab switch during the recording
//     await still defers, and a refocus mid-recording gets the immediate
//     path once recording finishes
//
// Rendered with @testing-library/react-native using the mock pattern from
// pos-card-tab-switch.test.tsx (virtual "@/" mocks, host-string RN
// stand-ins, require-after-mocks). Focus is driven by a mutable flag behind
// the useIsFocused mock plus RNTL's update() to re-render.

import React from "react";

// Host-component stand-ins: the screen's behaviour lives in props/handlers,
// not in native rendering. StyleSheet.flatten must exist because
// @testing-library/react-native reads it internally. virtual: true so the
// mock also intercepts RNTL's own require("react-native").
jest.mock(
  "react-native",
  () => ({
    Pressable: "Pressable",
    StyleSheet: {
      create: (styles: unknown) => styles,
      flatten: (style: unknown) => style,
    },
    Text: "Text",
    View: "View",
  }),
  { virtual: true }
);

const mockRouter = { back: jest.fn(), push: jest.fn(), replace: jest.fn() };

jest.mock("expo-router", () => ({ useRouter: () => mockRouter }), {
  virtual: true,
});

// Focus is scenario-controlled: tests flip mockFocused and re-render to
// simulate the seller leaving and returning to the Sell tab.
let mockFocused = true;

jest.mock("@react-navigation/native", () => ({
  useIsFocused: () => mockFocused,
}));

jest.mock("expo-crypto", () => ({ randomUUID: () => "sale-uuid-1" }), {
  virtual: true,
});

// No digital payment methods: only the "Cash / other" button renders.
jest.mock(
  "@tanstack/react-query",
  () => ({
    useQuery: () => ({
      data: { lightning: false, stripeTerminal: false, square: false },
      isLoading: false,
    }),
  }),
  { virtual: true }
);

// Deterministic cart totals — the arithmetic itself is covered by the domain
// package's own tests.
jest.mock("@self-sown/domain", () => ({
  computePosCartTotals: jest.fn(() => ({
    total: 12,
    currency: "usd",
    itemCount: 1,
    savings: 0,
  })),
  pricePosCartLine: jest.fn(() => ({ total: 12, savings: 0 })),
  validatePosBuyerEmail: jest.fn(() => null),
  validatePosNote: jest.fn(() => null),
}));

// --- Sale-pipeline mocks -----------------------------------------------------
const mockFinalizePosSale = jest.fn();
const mockCompleteSale = jest.fn();

// The screen imports "@/..." modules; the next/jest SWC transform rewrites
// those aliases with the ROOT tsconfig paths ("@/*" -> "./*"), so they arrive
// at jest's resolver as root-relative specifiers that don't exist. Register
// virtual mocks keyed at those same root-relative paths (as seen from this
// test file). See pos-card-tab-switch.test.tsx for the same pattern.
jest.mock(
  "../../lib/pos-cart-store",
  () => ({
    usePosCartStore: (selector: (state: unknown) => unknown) =>
      selector({
        lines: [
          {
            key: "line-1",
            item: { title: "Jar of honey", currency: "usd" },
            quantity: 1,
          },
        ],
        note: "",
        buyerEmail: "",
        setQuantity: jest.fn(),
        removeLine: jest.fn(),
        setNote: jest.fn(),
        setBuyerEmail: jest.fn(),
        beginSale: jest.fn(),
        completeSale: (...args: unknown[]) => mockCompleteSale(...args),
      }),
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
  "../../lib/pos-sale",
  () => ({
    finalizePosSale: (...args: unknown[]) => mockFinalizePosSale(...args),
  }),
  { virtual: true }
);

jest.mock(
  "../../lib/pos-receipt",
  () => ({ buildPosReceiptLines: jest.fn(() => []) }),
  { virtual: true }
);

jest.mock(
  "../../lib/pos-fx",
  () => ({ formatPosAmount: (total: number) => `$${total.toFixed(2)}` }),
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
  "../../lib/nwc",
  () => ({ loadNwcConnection: jest.fn(async () => null) }),
  { virtual: true }
);

jest.mock(
  "../../lib/account-settings",
  () => ({ loadAccountPreferences: jest.fn(async () => null) }),
  { virtual: true }
);

jest.mock(
  "../../lib/pos-api",
  () => ({ fetchPosPaymentMethods: jest.fn(async () => null) }),
  { virtual: true }
);

jest.mock(
  "../../lib/pos-stripe-terminal",
  () => ({ isStripeTerminalAvailable: () => false }),
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
    SellerField: "SellerField",
  }),
  { virtual: true }
);

jest.mock(
  "../../components/apple-pay-mark",
  () => ({ ApplePayMark: "ApplePayMark" }),
  { virtual: true }
);

jest.mock(
  "../../theme/tokens",
  () => ({
    sellerFonts: {
      regular: "Test-Regular",
      semibold: "Test-Semibold",
      bold: "Test-Bold",
      extrabold: "Test-Extrabold",
    },
    sellerThemeTokens: {
      black: "#000000",
      danger: "#ff0000",
      mutedText: "#888888",
      primary: "#00aa00",
      subduedSurface: "#eeeeee",
      success: "#00aa00",
      surface: "#ffffff",
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
const { render, act, fireEvent } =
  require("@testing-library/react-native") as typeof import("@testing-library/react-native");

// Requiring (not importing) the screen keeps its "@/..." mobile aliases out
// of the root tsc program: the web tsconfig maps "@/*" to the repo root,
// where the mobile modules don't exist, so a static import would fail the
// project typecheck. Jest resolves the module at runtime against the mocks
// registered above.
const { default: PosCartScreen } =
  require("../../apps/mobile/app/(tabs)/pos/cart") as {
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
  app = await render(React.createElement(PosCartScreen));
}

async function pressButton(label: string) {
  const button = findButton(label);
  expect(button).toBeDefined();
  await fireEvent.press(button!);
  await flushMicrotasks();
}

// Simulates the seller returning to the Sell tab: useIsFocused flips and the
// screen re-renders, which runs the refocus effect.
async function refocusScreen() {
  mockFocused = true;
  await act(async () => {
    app.rerender(React.createElement(PosCartScreen));
  });
  await flushMicrotasks();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFocused = true;
  usePosCardOutcomeStore.getState().clearUnseenOutcome();
  mockFinalizePosSale.mockResolvedValue({ saleId: "sale-1" });
});

describe("PoS cash completion tab-switch outcome wiring", () => {
  it("a cash sale recorded while unfocused badges the Sell tab and defers the success navigation to refocus", async () => {
    mockFocused = false;

    await renderScreen();
    await pressButton("Cash / other");

    // The sale is still recorded even though nobody is watching the screen.
    expect(mockFinalizePosSale).toHaveBeenCalledTimes(1);
    expect(mockCompleteSale).toHaveBeenCalledTimes(1);

    // No navigation fires behind the tab the seller is looking at; the
    // outcome is signaled via the store the Sell tab badges from.
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(usePosCardOutcomeStore.getState().unseenOutcome).toEqual({
      approved: true,
      amountText: "$12.00",
    });

    // Returning to the Sell tab runs the deferred success navigation exactly
    // once and clears the badge signal.
    await refocusScreen();
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledWith("/(tabs)/pos/success");
    expect(usePosCardOutcomeStore.getState().unseenOutcome).toBeNull();

    // Later re-renders never repeat the navigation.
    await flushMicrotasks();
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
  });

  it("a cash sale recorded while focused navigates immediately with no badge", async () => {
    mockFocused = true;

    await renderScreen();
    await pressButton("Cash / other");

    expect(mockCompleteSale).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledWith("/(tabs)/pos/success");
    expect(usePosCardOutcomeStore.getState().unseenOutcome).toBeNull();

    // No double navigation on later re-renders.
    await flushMicrotasks();
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
  });

  it("a tab switch during the recording await still defers the success navigation", async () => {
    // Pressed while FOCUSED, but the seller switches tabs while
    // finalizePosSale is still recording: focus must be sampled at
    // completion, or the replace fires behind the other tab.
    mockFocused = true;
    let resolveFinalize: (value: { saleId: string }) => void = () => {};
    mockFinalizePosSale.mockReturnValue(
      new Promise((resolve) => {
        resolveFinalize = resolve;
      })
    );

    await renderScreen();
    await pressButton("Cash / other");
    expect(mockFinalizePosSale).toHaveBeenCalledTimes(1);

    // The seller switches away mid-recording.
    mockFocused = false;
    await act(async () => {
      app.rerender(React.createElement(PosCartScreen));
    });
    await flushMicrotasks();

    resolveFinalize({ saleId: "sale-1" });
    await flushMicrotasks();

    // The sale is recorded, but no navigation fired behind the other tab:
    // the outcome is signaled and the success navigation is deferred.
    expect(mockCompleteSale).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(usePosCardOutcomeStore.getState().unseenOutcome).toEqual({
      approved: true,
      amountText: "$12.00",
    });

    await refocusScreen();
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledWith("/(tabs)/pos/success");
    expect(usePosCardOutcomeStore.getState().unseenOutcome).toBeNull();
  });

  it("a refocus during the recording await does not navigate before the sale is recorded", async () => {
    // Pressed while UNFOCUSED, and the seller returns while finalizePosSale
    // is still recording: the success navigation must wait for the recording
    // to finish, then take the immediate focused path.
    mockFocused = false;
    let resolveFinalize: (value: { saleId: string }) => void = () => {};
    mockFinalizePosSale.mockReturnValue(
      new Promise((resolve) => {
        resolveFinalize = resolve;
      })
    );

    await renderScreen();
    await pressButton("Cash / other");
    expect(mockFinalizePosSale).toHaveBeenCalledTimes(1);

    // The seller returns mid-recording: nothing navigates yet (the sale is
    // not recorded) and no badge was armed.
    await refocusScreen();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(mockCompleteSale).not.toHaveBeenCalled();
    expect(usePosCardOutcomeStore.getState().unseenOutcome).toBeNull();

    // Recording finishes with the seller watching: immediate navigation, no
    // badge.
    resolveFinalize({ saleId: "sale-1" });
    await flushMicrotasks();
    expect(mockCompleteSale).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledWith("/(tabs)/pos/success");
    expect(usePosCardOutcomeStore.getState().unseenOutcome).toBeNull();
  });

  it("a recording failure while unfocused badges the failure and never navigates to success", async () => {
    // The recording failed while the seller was away: the deferred marker
    // must NOT be armed, or refocus would navigate to success for an
    // unrecorded sale.
    mockFocused = false;
    mockFinalizePosSale.mockRejectedValue(new Error("Could not record the sale."));

    await renderScreen();
    await pressButton("Cash / other");

    expect(mockCompleteSale).not.toHaveBeenCalled();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(usePosCardOutcomeStore.getState().unseenOutcome).toEqual({
      approved: false,
      amountText: "$12.00",
      message: "Could not record the sale.",
    });

    // Returning to the Sell tab shows the error state — no success
    // navigation for a sale that was never recorded — and clears the badge.
    await refocusScreen();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    const errorText = hostNodesOfType("Text").find(
      (node) => node.props.children === "Could not record the sale."
    );
    expect(errorText).toBeDefined();
    expect(usePosCardOutcomeStore.getState().unseenOutcome).toBeNull();
  });

  it("a recording failure while focused shows the error with no badge", async () => {
    mockFocused = true;
    mockFinalizePosSale.mockRejectedValue(new Error("Could not record the sale."));

    await renderScreen();
    await pressButton("Cash / other");

    expect(mockCompleteSale).not.toHaveBeenCalled();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(usePosCardOutcomeStore.getState().unseenOutcome).toBeNull();
    const errorText = hostNodesOfType("Text").find(
      (node) => node.props.children === "Could not record the sale."
    );
    expect(errorText).toBeDefined();
  });
});
