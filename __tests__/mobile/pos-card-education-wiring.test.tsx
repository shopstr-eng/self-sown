/** @jest-environment node */

// Wiring test for the Tap to Pay education gate inside the PoS card checkout
// screen (apps/mobile/app/(tabs)/pos/card.tsx). The gate's pause/resume
// contract is unit-tested in tap-to-pay-education-gate.test.ts; this suite
// pins the screen-level wiring Apple checklist Req 4.2 depends on, so a
// refactor cannot silently regress the App Review flow:
//   - a fresh first connect opens the education modal and the charge waits
//     for dismissal BEFORE any payment intent is created
//   - a reused live reader connection with the education already seen skips
//     the pause entirely (no discovery, no modal, straight to the charge)
//   - leaving the screen mid-education releases the paused sale (it cannot
//     hang forever) without charging and without marking the education seen
//
// Rendered with @testing-library/react-native (v14+, backed by the
// maintained `test-renderer` package) — NOT react-test-renderer, which React
// upstream deprecated. See tap-to-pay-education-modal.test.tsx for the
// pattern this copies (virtual host-string mocks, require-after-mocks,
// render-result queries).

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
// mock also intercepts RNTL's own require("react-native"), which resolves to
// a pnpm peer-context path a non-virtual mock never matches.
jest.mock(
  "react-native",
  () => ({
    Alert: { alert: (...args: unknown[]) => mockAlert(...args) },
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

// Navigation-container hooks: the card screen blocks back navigation while a
// charge is in flight. usePreventRemove's arguments are captured per render
// so tests can assert exactly when the block is on.
const mockNavigation = { setOptions: jest.fn(), dispatch: jest.fn() };
const mockUsePreventRemove = jest.fn();

const mockAlert = jest.fn();

jest.mock("@react-navigation/native", () => ({
  useNavigation: () => mockNavigation,
  usePreventRemove: (...args: unknown[]) => mockUsePreventRemove(...args),
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
// The screen talks to the native SDK through module.useStripeTerminal(); the
// stub captures the discovery listener so tests can simulate a reader being
// found, and every SDK call is a jest.fn controlled per scenario.
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

let mockDiscoveredReadersListener: ((readers: unknown[]) => void) | null = null;

const mockTerminalModule = {
  useStripeTerminal: (callbacks?: {
    onUpdateDiscoveredReaders?: (readers: unknown[]) => void;
  }) => {
    mockDiscoveredReadersListener =
      callbacks?.onUpdateDiscoveredReaders ?? null;
    return mockTerminal;
  },
};

// --- Charge-pipeline mocks ---------------------------------------------------
const mockCreatePaymentIntent = jest.fn();
const mockExecuteCardPayment = jest.fn();
const mockFinalizePosSale = jest.fn();
const mockCompleteSale = jest.fn();

// Gate instances created by the screen, captured so tests can assert on the
// pause state directly (a released gate is the proof the sale cannot hang).
import type { TapToPayEducationGate } from "../../apps/mobile/lib/tap-to-pay-education";
const mockGates: TapToPayEducationGate[] = [];

// The screen imports "@/..." modules; the next/jest SWC transform rewrites
// those aliases with the ROOT tsconfig paths ("@/*" -> "./*"), so they arrive
// at jest's resolver as root-relative specifiers that don't exist. Register
// virtual mocks keyed at those same root-relative paths (as seen from this
// test file). See tap-to-pay-education-modal.test.tsx for the same pattern.
jest.mock(
  "../../lib/tap-to-pay-education",
  () => {
    const actual = jest.requireActual(
      "../../apps/mobile/lib/tap-to-pay-education"
    ) as typeof import("../../apps/mobile/lib/tap-to-pay-education");
    return {
      ...actual,
      // Wrap gate creation so tests can observe the pause state of the exact
      // gate instance the screen is wired to.
      createTapToPayEducationGate: () => {
        const gate = actual.createTapToPayEducationGate();
        mockGates.push(gate);
        return gate;
      },
    };
  },
  { virtual: true }
);

jest.mock(
  "../../lib/pos-stripe-terminal",
  () => ({ getStripeTerminalModule: () => mockTerminalModule }),
  { virtual: true }
);

jest.mock(
  "../../lib/pos-tap-to-pay",
  () => ({ awaitPendingTapToPayWarmup: jest.fn(async () => undefined) }),
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
    canRetryCardPayment: jest.fn(() => true),
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
  "../../lib/pos-card-outcome-store",
  () =>
    jest.requireActual(
      "../../apps/mobile/lib/pos-card-outcome-store"
    ) as unknown,
  { virtual: true }
);

jest.mock(
  "../../lib/pos-receipt",
  () => ({
    buildPosReceiptLines: jest.fn(() => []),
    formatDeclinedCardReceiptText: jest.fn(() => ""),
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

// The real modal (slide content, navigation) is covered by
// tap-to-pay-education-modal.test.tsx; here a host stand-in exposes the two
// props that matter to the wiring: `visible` and `onDone`.
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

import {
  markTapToPayEducationSeen,
  tapToPayEducationStorageKey,
} from "../../apps/mobile/lib/tap-to-pay-education";

// Requiring (not importing) @testing-library/react-native keeps the
// jest.mock("react-native", ...) registration above in effect when RNTL
// loads: the next/jest SWC transform does NOT hoist jest.mock calls above
// static ESM imports, and RNTL requires the real (ESM, untransformed)
// react-native at module load, which would crash before the mock registers.
// NOTE: RNTL v14's exported `screen` is a placeholder proxy that render()
// REPLACES, so never destructure it — use the render() result's queries.
const { render, act, fireEvent } =
  require("@testing-library/react-native") as typeof import("@testing-library/react-native");

// The AsyncStorage module is mocked above; grab the getItem jest.fn so a
// test can hold the education seen-check open across an unmount. Required
// (not imported) for the same reason as the screen below: the root tsconfig
// cannot resolve mobile-only packages, and jest maps this specifier to the
// virtual mock at runtime.
const mockStorageGetItem = (
  require("@react-native-async-storage/async-storage") as {
    getItem: jest.Mock;
  }
).getItem;

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

// The host-node type `container.queryAll` returns. The concrete TestInstance
// class comes from RNTL's nested `test-renderer` package, which the root tsc
// program cannot import by name, so derive it from the render result
// instead. (A hand-written structural type does NOT work: fireEvent requires
// the real TestInstance, which has private members.)
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

function findModal(): HostNode {
  const modals = hostNodesOfType("TapToPayEducationModal");
  expect(modals).toHaveLength(1);
  return modals[0]!;
}

async function flushMicrotasks() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

async function renderScreen() {
  app = await render(React.createElement(PosCardScreen));
}

async function pressCharge() {
  const button = findButton("Charge $12.00");
  expect(button).toBeDefined();
  await fireEvent.press(button!);
  // Let the sale's async chain settle as far as it can (it should pause on
  // the education gate, or run to completion when the pause is skipped).
  await flushMicrotasks();
}

beforeEach(() => {
  asyncStorageStore.clear();
  jest.clearAllMocks();
  mockGates.length = 0;
  mockDiscoveredReadersListener = null;
  mockUsePreventRemove.mockClear();

  // Default fresh-connect path: discovery finds one reader, a Terminal
  // location exists, and connect succeeds.
  mockTerminal.getConnectedReader.mockResolvedValue(null);
  mockTerminal.discoverReaders.mockImplementation(async () => {
    mockDiscoveredReadersListener?.([{ id: "reader-1" }]);
    return {};
  });
  mockTerminal.getLocations.mockResolvedValue({ locations: [{ id: "loc-1" }] });
  mockTerminal.connectReader.mockResolvedValue({});

  mockCreatePaymentIntent.mockResolvedValue({
    clientSecret: "pi_secret_1",
    paymentIntentId: "pi_1",
  });
  mockExecuteCardPayment.mockResolvedValue({ kind: "approved" });
  mockFinalizePosSale.mockResolvedValue({ saleId: "sale-1" });
});

describe("PoS card checkout Tap to Pay education wiring", () => {
  it("fresh first connect shows the education and the charge waits for dismissal", async () => {
    await renderScreen();

    await pressCharge();

    // Fresh connect: discovery and connect ran (T&C acceptance happens
    // natively there), then the education opened.
    expect(mockTerminal.discoverReaders).toHaveBeenCalledTimes(1);
    expect(mockTerminal.connectReader).toHaveBeenCalledTimes(1);
    expect(findModal().props.visible).toBe(true);

    // The sale is paused on the gate: NO payment intent may be created while
    // the education is up (Req 4.2 — education before the first charge).
    expect(mockGates).toHaveLength(1);
    expect(mockGates[0]!.isPaused()).toBe(true);
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
    expect(mockExecuteCardPayment).not.toHaveBeenCalled();

    // Dismissal releases the pause and the charge proceeds to completion.
    const modal = findModal();
    await act(async () => {
      modal.props.onDone();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });

    expect(mockCreatePaymentIntent).toHaveBeenCalledTimes(1);
    expect(mockExecuteCardPayment).toHaveBeenCalledTimes(1);
    expect(mockFinalizePosSale).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledWith("/(tabs)/pos/success");
    // Dismissal marked the education seen for this seller.
    expect(
      asyncStorageStore.get(tapToPayEducationStorageKey("pk-seller"))
    ).toBe("1");
  });

  it("reused live connection with the education already seen skips the pause and charges immediately", async () => {
    await markTapToPayEducationSeen("pk-seller");
    mockTerminal.getConnectedReader.mockResolvedValue({ id: "reader-live" });

    await renderScreen();
    await pressCharge();

    // The live connection is reused: no discovery, no reconnect, no
    // education modal, no gate pause — straight to the charge.
    expect(mockTerminal.discoverReaders).not.toHaveBeenCalled();
    expect(mockTerminal.connectReader).not.toHaveBeenCalled();
    expect(findModal().props.visible).toBe(false);
    expect(mockGates[0]!.isPaused()).toBe(false);
    expect(mockCreatePaymentIntent).toHaveBeenCalledTimes(1);
    expect(mockExecuteCardPayment).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledWith("/(tabs)/pos/success");
  });

  it("reused live connection does NOT skip the education when the seller has never seen it", async () => {
    // Regression pin for the documented invariant in card.tsx: the pause is
    // keyed off the per-seller seen flag alone. A seller whose first attempt
    // was cancelled mid-education still has the connection cached — keying
    // the skip off connection reuse would let them charge without ever
    // seeing the education.
    mockTerminal.getConnectedReader.mockResolvedValue({ id: "reader-live" });

    await renderScreen();
    await pressCharge();

    expect(mockTerminal.discoverReaders).not.toHaveBeenCalled();
    expect(findModal().props.visible).toBe(true);
    expect(mockGates[0]!.isPaused()).toBe(true);
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled();

    // Dismissal still releases into a normal charge.
    const modal = findModal();
    await act(async () => {
      modal.props.onDone();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    expect(mockCreatePaymentIntent).toHaveBeenCalledTimes(1);
  });

  it("leaving the screen mid-education releases the sale: no hang, no charge, education not marked seen", async () => {
    await renderScreen();

    await pressCharge();
    expect(findModal().props.visible).toBe(true);
    expect(mockGates[0]!.isPaused()).toBe(true);

    // Capture the modal's exit handler: a stale dismissal can still arrive
    // after the screen is gone (e.g. the modal's exit animation completing
    // after unmount).
    const staleOnDone = findModal().props.onDone as () => void;

    // Screen exit (back nav / unmount) while paused. The unmount cleanup in
    // card.tsx must cancel the gate, or runSale hangs forever on a modal
    // that can no longer be dismissed.
    await app.unmount();
    await flushMicrotasks();

    // The pause was released — the sale cannot hang — and cancel (unlike
    // dismiss) must NOT mark the education seen, so the next first charge
    // pauses again.
    expect(mockGates[0]!.isPaused()).toBe(false);
    expect(
      asyncStorageStore.get(tapToPayEducationStorageKey("pk-seller"))
    ).toBeUndefined();

    // A stale dismissal landing after unmount must not resume into a charge.
    staleOnDone();
    await flushMicrotasks();
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
    expect(mockExecuteCardPayment).not.toHaveBeenCalled();
    expect(mockFinalizePosSale).not.toHaveBeenCalled();
  });

  it("blocks back navigation once a payment intent exists, and lets only the success replace through", async () => {
    // Education already seen: the sale goes straight to the charge.
    await markTapToPayEducationSeen("pk-seller");
    mockTerminal.getConnectedReader.mockResolvedValue({ id: "reader-live" });

    // Hold the card payment open in the "ready" phase until the test lets it
    // finish, so the in-flight window is observable.
    let resolvePayment!: (value: { kind: "approved" }) => void;
    mockExecuteCardPayment.mockImplementation(
      (_ops: unknown, _secret: unknown, onPhase?: (step: string) => void) =>
        new Promise((resolve) => {
          onPhase?.("ready");
          resolvePayment = resolve;
        })
    );

    await renderScreen();
    await pressCharge();

    // The charge is in flight (ready): back navigation must be blocked and
    // the swipe-back gesture disabled.
    expect(mockCreatePaymentIntent).toHaveBeenCalledTimes(1);
    expect(mockUsePreventRemove.mock.calls.at(-1)?.[0]).toBe(true);
    expect(mockNavigation.setOptions).toHaveBeenLastCalledWith({
      gestureEnabled: false,
    });

    // A removal attempt mid-charge (back button / hardware back) is refused
    // with an explanation — the action is NOT dispatched.
    const removalAction = { type: "GO_BACK" };
    const blockedCallback = mockUsePreventRemove.mock.calls.at(
      -1
    )?.[1] as (event: { data: { action: unknown } }) => void;
    blockedCallback({ data: { action: removalAction } });
    expect(mockNavigation.dispatch).not.toHaveBeenCalled();
    expect(mockAlert).toHaveBeenCalledWith(
      "Card payment in progress",
      expect.stringContaining("Wait for the payment")
    );

    // The charge resolves: the sale finalizes and the screen navigates to
    // success. The guard arms a pass-through for exactly that replace —
    // re-invoking the guard now dispatches the pending action.
    await act(async () => {
      resolvePayment({ kind: "approved" });
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    expect(mockFinalizePosSale).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledWith("/(tabs)/pos/success");
    const armedCallback = mockUsePreventRemove.mock.calls.at(
      -1
    )?.[1] as (event: { data: { action: unknown } }) => void;
    armedCallback({ data: { action: removalAction } });
    expect(mockNavigation.dispatch).toHaveBeenCalledWith(removalAction);
  });

  it("lifts the navigation block when the charge fails back to the error state", async () => {
    await markTapToPayEducationSeen("pk-seller");
    mockTerminal.getConnectedReader.mockResolvedValue({ id: "reader-live" });
    mockExecuteCardPayment.mockResolvedValue({
      kind: "not-approved",
      message: "The card was declined.",
    });

    await renderScreen();
    await pressCharge();

    // The decline landed on the error screen: the charge is over, so back
    // navigation and the swipe gesture are free again.
    expect(mockUsePreventRemove.mock.calls.at(-1)?.[0]).toBe(false);
    expect(mockNavigation.setOptions).toHaveBeenLastCalledWith({
      gestureEnabled: true,
    });
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(findButton("Try again")).toBeDefined();
  });

  it("leaving during discovery aborts the sale before any payment intent is created", async () => {
    // Hold discovery open so the seller can leave mid-discovery (nothing is
    // charged yet, so navigation is NOT blocked in this phase).
    let finishDiscovery!: () => void;
    mockTerminal.discoverReaders.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishDiscovery = () => {
            mockDiscoveredReadersListener?.([{ id: "reader-1" }]);
            resolve({});
          };
        })
    );

    await renderScreen();
    await pressCharge();

    // Still pre-charge: no navigation block.
    expect(mockUsePreventRemove.mock.calls.at(-1)?.[0]).toBe(false);

    await app.unmount();
    // Discovery finishes after the screen is gone.
    await act(async () => {
      finishDiscovery();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });

    // The sale aborted: it never reached connect, education, or the charge.
    expect(mockTerminal.connectReader).not.toHaveBeenCalled();
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
    expect(mockExecuteCardPayment).not.toHaveBeenCalled();
    expect(mockFinalizePosSale).not.toHaveBeenCalled();
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it("leaving while the education seen-check settles aborts before any payment intent when the check resolves false", async () => {
    // Educated seller on a live connection: the seen-check resolves false,
    // the normal path straight to the charge.
    await markTapToPayEducationSeen("pk-seller");
    mockTerminal.getConnectedReader.mockResolvedValue({ id: "reader-live" });

    // Hold the AsyncStorage read open so the seller leaves while the
    // seen-check is still in flight.
    let finishRead!: () => void;
    mockStorageGetItem.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = () =>
            resolve(
              asyncStorageStore.get(
                tapToPayEducationStorageKey("pk-seller")
              ) ?? null
            );
        })
    );

    await renderScreen();
    await pressCharge();

    // The sale reached the seen-check and is waiting on the storage read.
    expect(mockTerminal.getConnectedReader).toHaveBeenCalledTimes(1);
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled();

    await app.unmount();
    // The read settles false AFTER the screen is gone.
    await act(async () => {
      finishRead();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });

    // The sale aborted at the seen-check: no modal, no payment intent, no
    // charge, no navigation.
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
    expect(mockExecuteCardPayment).not.toHaveBeenCalled();
    expect(mockFinalizePosSale).not.toHaveBeenCalled();
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it("an unmount racing a late charge result still records the sale but never navigates", async () => {
    // Education already seen: the sale goes straight to the charge.
    await markTapToPayEducationSeen("pk-seller");
    mockTerminal.getConnectedReader.mockResolvedValue({ id: "reader-live" });

    let resolvePayment!: (value: { kind: "approved" }) => void;
    mockExecuteCardPayment.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePayment = resolve;
        })
    );

    await renderScreen();
    await pressCharge();
    expect(mockCreatePaymentIntent).toHaveBeenCalledTimes(1);

    // App teardown (the only way out mid-charge — navigation is blocked):
    // the screen unmounts while the charge is still open.
    await app.unmount();
    await act(async () => {
      resolvePayment({ kind: "approved" });
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });

    // The paid charge is still finalized and recorded, but no state update
    // or navigation fires on the gone screen.
    expect(mockFinalizePosSale).toHaveBeenCalledTimes(1);
    expect(mockCompleteSale).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it("offers Cancel payment while waiting for the tap, and cancelling unwinds to a retryable state", async () => {
    await markTapToPayEducationSeen("pk-seller");
    mockTerminal.getConnectedReader.mockResolvedValue({ id: "reader-live" });

    // Hold the charge open in the ready phase and capture the cancel hook
    // the screen threads into executeCardPayment.
    let cancelHook: { isCancelRequested: () => boolean } | undefined;
    let resolvePayment!: (value: { kind: "cancelled"; message: string }) => void;
    mockExecuteCardPayment.mockImplementation(
      (
        _ops: unknown,
        _secret: unknown,
        onPhase?: (step: string) => void,
        cancel?: { isCancelRequested: () => boolean }
      ) => {
        cancelHook = cancel;
        onPhase?.("ready");
        return new Promise((resolve) => {
          resolvePayment = resolve;
        });
      }
    );

    await renderScreen();
    await pressCharge();

    // Ready phase: the in-screen escape hatch is visible and no cancel is
    // pending yet.
    const cancelButton = findButton("Cancel payment");
    expect(cancelButton).toBeDefined();
    expect(cancelHook?.isCancelRequested()).toBe(false);

    // Tapping it cancels the in-flight collect through the SDK and flips
    // the hook executeCardPayment consults to tell a cancel from a decline.
    await fireEvent.press(cancelButton!);
    expect(mockTerminal.cancelCollectPaymentMethod).toHaveBeenCalledTimes(1);
    expect(cancelHook?.isCancelRequested()).toBe(true);

    // The cancelled collect resolves: unwind to a retryable state — no sale
    // recorded, navigation unblocked, and a fresh charge can be started.
    await act(async () => {
      resolvePayment({ kind: "cancelled", message: "Payment cancelled. Nothing was charged." });
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    expect(mockFinalizePosSale).not.toHaveBeenCalled();
    expect(mockCompleteSale).not.toHaveBeenCalled();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(mockUsePreventRemove.mock.calls.at(-1)?.[0]).toBe(false);
    expect(mockNavigation.setOptions).toHaveBeenLastCalledWith({
      gestureEnabled: true,
    });
    expect(findButton("Try again")).toBeDefined();

    // The retry starts clean: the next attempt must not inherit the cancel
    // flag from the cancelled one (or a real decline would read as a cancel).
    let secondHook: { isCancelRequested: () => boolean } | undefined;
    mockExecuteCardPayment.mockImplementation(
      (
        _ops: unknown,
        _secret: unknown,
        onPhase?: (step: string) => void,
        cancel?: { isCancelRequested: () => boolean }
      ) => {
        secondHook = cancel;
        onPhase?.("ready");
        return new Promise(() => {});
      }
    );
    await fireEvent.press(findButton("Try again")!);
    await flushMicrotasks();
    expect(secondHook?.isCancelRequested()).toBe(false);
  });

  it("never offers Cancel payment during processing, and keeps navigation blocked", async () => {
    await markTapToPayEducationSeen("pk-seller");
    mockTerminal.getConnectedReader.mockResolvedValue({ id: "reader-live" });

    // Drive the phase transitions the way executeCardPayment does.
    let phaseSink: ((step: string) => void) | undefined;
    let resolvePayment!: (value: { kind: "approved" }) => void;
    mockExecuteCardPayment.mockImplementation(
      (_ops: unknown, _secret: unknown, onPhase?: (step: string) => void) => {
        phaseSink = onPhase;
        return new Promise((resolve) => {
          resolvePayment = resolve;
        });
      }
    );

    await renderScreen();
    await pressCharge();

    await act(async () => {
      phaseSink?.("ready");
    });
    expect(findButton("Cancel payment")).toBeDefined();

    // Processing (confirm in flight): cancelling there could leave the
    // buyer charged with the sale unrecorded, so the button must disappear
    // and the navigation block must stay on.
    await act(async () => {
      phaseSink?.("processing");
    });
    expect(findButton("Cancel payment")).toBeUndefined();
    expect(mockUsePreventRemove.mock.calls.at(-1)?.[0]).toBe(true);
    expect(mockNavigation.setOptions).toHaveBeenLastCalledWith({
      gestureEnabled: false,
    });

    // Let the charge finish so nothing dangles past unmount.
    await act(async () => {
      resolvePayment({ kind: "approved" });
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    expect(mockRouter.replace).toHaveBeenCalledWith("/(tabs)/pos/success");
    expect(mockTerminal.cancelCollectPaymentMethod).not.toHaveBeenCalled();
  });
});
