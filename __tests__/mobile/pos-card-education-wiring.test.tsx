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

import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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
// not in native rendering.
jest.mock("react-native", () => ({
  Alert: { alert: (...args: unknown[]) => mockAlert(...args) },
  Share: { share: jest.fn(async () => ({})) },
  StyleSheet: { create: (styles: unknown) => styles },
  Text: "Text",
  View: "View",
}));

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
  () => ({ notifyCardPaymentNotApproved: jest.fn(async () => undefined) }),
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

// The react-native/seller-ui mocks are host-string stand-ins; the renderer's
// types only accept ElementType, so cast once at the lookup sites.
const host = (name: string) => name as unknown as React.ElementType;

type ButtonProps = { label: string; onPress: () => void };
type ModalProps = { visible: boolean; onDone: () => void };

function findButton(root: ReactTestInstance, label: string) {
  return root
    .findAllByType(host("ActionButton"))
    .find((b) => (b.props as ButtonProps).label === label);
}

function findModal(root: ReactTestInstance) {
  return root.findByType(host("TapToPayEducationModal"));
}

async function flushMicrotasks() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

function renderScreen() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(PosCardScreen));
  });
  return renderer;
}

async function pressCharge(root: ReactTestInstance) {
  const button = findButton(root, "Charge $12.00");
  expect(button).toBeDefined();
  await act(async () => {
    (button!.props as ButtonProps).onPress();
    // Let the sale's async chain settle as far as it can (it should pause on
    // the education gate, or run to completion when the pause is skipped).
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
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
    const { root } = renderScreen();

    await pressCharge(root);

    // Fresh connect: discovery and connect ran (T&C acceptance happens
    // natively there), then the education opened.
    expect(mockTerminal.discoverReaders).toHaveBeenCalledTimes(1);
    expect(mockTerminal.connectReader).toHaveBeenCalledTimes(1);
    expect((findModal(root).props as ModalProps).visible).toBe(true);

    // The sale is paused on the gate: NO payment intent may be created while
    // the education is up (Req 4.2 — education before the first charge).
    expect(mockGates).toHaveLength(1);
    expect(mockGates[0]!.isPaused()).toBe(true);
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
    expect(mockExecuteCardPayment).not.toHaveBeenCalled();

    // Dismissal releases the pause and the charge proceeds to completion.
    await act(async () => {
      (findModal(root).props as ModalProps).onDone();
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

    const { root } = renderScreen();
    await pressCharge(root);

    // The live connection is reused: no discovery, no reconnect, no
    // education modal, no gate pause — straight to the charge.
    expect(mockTerminal.discoverReaders).not.toHaveBeenCalled();
    expect(mockTerminal.connectReader).not.toHaveBeenCalled();
    expect((findModal(root).props as ModalProps).visible).toBe(false);
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

    const { root } = renderScreen();
    await pressCharge(root);

    expect(mockTerminal.discoverReaders).not.toHaveBeenCalled();
    expect((findModal(root).props as ModalProps).visible).toBe(true);
    expect(mockGates[0]!.isPaused()).toBe(true);
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled();

    // Dismissal still releases into a normal charge.
    await act(async () => {
      (findModal(root).props as ModalProps).onDone();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    expect(mockCreatePaymentIntent).toHaveBeenCalledTimes(1);
  });

  it("leaving the screen mid-education releases the sale: no hang, no charge, education not marked seen", async () => {
    const renderer = renderScreen();
    const { root } = renderer;

    await pressCharge(root);
    expect((findModal(root).props as ModalProps).visible).toBe(true);
    expect(mockGates[0]!.isPaused()).toBe(true);

    // Capture the modal's exit handler: a stale dismissal can still arrive
    // after the screen is gone (e.g. the modal's exit animation completing
    // after unmount).
    const staleOnDone = (findModal(root).props as ModalProps).onDone;

    // Screen exit (back nav / unmount) while paused. The unmount cleanup in
    // card.tsx must cancel the gate, or runSale hangs forever on a modal
    // that can no longer be dismissed.
    act(() => {
      renderer.unmount();
    });
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

    const { root } = renderScreen();
    await pressCharge(root);

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

    const { root } = renderScreen();
    await pressCharge(root);

    // The decline landed on the error screen: the charge is over, so back
    // navigation and the swipe gesture are free again.
    expect(mockUsePreventRemove.mock.calls.at(-1)?.[0]).toBe(false);
    expect(mockNavigation.setOptions).toHaveBeenLastCalledWith({
      gestureEnabled: true,
    });
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(findButton(root, "Try again")).toBeDefined();
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

    const renderer = renderScreen();
    await pressCharge(renderer.root);

    // Still pre-charge: no navigation block.
    expect(mockUsePreventRemove.mock.calls.at(-1)?.[0]).toBe(false);

    act(() => {
      renderer.unmount();
    });
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

    const renderer = renderScreen();
    await pressCharge(renderer.root);

    // The sale reached the seen-check and is waiting on the storage read.
    expect(mockTerminal.getConnectedReader).toHaveBeenCalledTimes(1);
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled();

    act(() => {
      renderer.unmount();
    });
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

    const renderer = renderScreen();
    await pressCharge(renderer.root);
    expect(mockCreatePaymentIntent).toHaveBeenCalledTimes(1);

    // App teardown (the only way out mid-charge — navigation is blocked):
    // the screen unmounts while the charge is still open.
    act(() => {
      renderer.unmount();
    });
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
});
