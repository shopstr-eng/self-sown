/** @jest-environment node */

// Entry-point wiring tests for the Tap to Pay merchant education modal
// (Apple checklist 4.2/4.3). The modal itself and the pause/resume gate are
// covered by tap-to-pay-education-modal.test.tsx and
// tap-to-pay-education-gate.test.ts, and the third entry point — the first
// checkout connect in app/(tabs)/pos/card.tsx — by
// pos-card-education-wiring.test.tsx. This suite pins the remaining two call
// sites so a regression cannot silently drop the modal or wire onDone
// without persisting "seen":
//   - components/tap-to-pay-awareness.tsx: education opens right after the
//     Terms acceptance inside the awareness enable flow (4.2), and Done
//     marks the education seen BEFORE the awareness moment dismisses
//   - app/(tabs)/settings/tap-to-pay.tsx: the enable path opens the
//     education after Terms acceptance (4.2), "Review the education"
//     reopens it anytime (4.3), and Done marks it seen on both paths

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

// Host-component stand-ins: behaviour lives in props/handlers, not in native
// rendering. StyleSheet.create is the identity.
jest.mock("react-native", () => ({
  Modal: "Modal",
  View: "View",
  Text: "Text",
  Image: "Image",
  StyleSheet: { create: (styles: unknown) => styles },
}));

// --- Stripe Terminal stub ---------------------------------------------------
// One terminal object satisfies both components: the awareness moment also
// destructures supportsReadersOfType/getIsInitialized, the settings screen
// passes its four methods into enableTapToPay (mocked below, args ignored).
const mockTerminal = {
  discoverReaders: jest.fn(),
  connectReader: jest.fn(),
  getConnectedReader: jest.fn(),
  getLocations: jest.fn(),
  supportsReadersOfType: jest.fn(),
  getIsInitialized: jest.fn(() => true),
};

const mockTerminalModule = {
  useStripeTerminal: () => mockTerminal,
  StripeTerminalProvider: "StripeTerminalProvider",
};

// --- Enable-flow mocks --------------------------------------------------------
const mockEnableTapToPay = jest.fn();
// Set inside markTapToPayAwarenessSeen so the awareness test can prove the
// education "seen" write landed BEFORE the awareness moment resumed (Apple
// 4.2's ordering: education completes, then the enable flow finishes).
let educationSeenBeforeAwarenessDismissed = false;

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

jest.mock(
  "../../lib/pos-tap-to-pay",
  () => ({
    awaitPendingTapToPayWarmup: jest.fn(async () => undefined),
    checkTapToPayDeviceSupport: jest.fn(async () => true),
    computeTapToPayEligibility: jest.fn(() => true),
    enableTapToPay: (...args: unknown[]) => mockEnableTapToPay(...args),
    hasSeenTapToPayAwareness: jest.fn(async () => false),
    markTapToPayAwarenessSeen: jest.fn(async () => {
      // Runs at the very end of the awareness onDone chain. Recording
      // whether the education write already landed proves the ordering.
      educationSeenBeforeAwarenessDismissed = asyncStorageStore.has(
        `tapToPay:education:pk-seller`
      );
    }),
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

// The real education lib: the persistence contract (per-pubkey storage key)
// is what these tests assert against, so only AsyncStorage underneath it is
// mocked.
jest.mock(
  "../../lib/tap-to-pay-education",
  () => jest.requireActual("../../apps/mobile/lib/tap-to-pay-education"),
  { virtual: true }
);

// The settings screen wraps itself in this provider; the SDK provider
// contract is irrelevant to the education wiring, so render children
// straight through.
jest.mock(
  "../../components/tap-to-pay-provider",
  () => ({
    TapToPayProvider: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
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

// The real modal (slides, navigation) is covered by
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
    sellerFonts: {
      extrabold: "Test-Extrabold",
      regular: "Test-Regular",
      semibold: "Test-Semibold",
    },
    sellerThemeTokens: {
      background: "#ffffff",
      danger: "#ff0000",
      mutedText: "#888888",
      success: "#00aa00",
      text: "#111111",
    },
  }),
  { virtual: true }
);

import { tapToPayEducationStorageKey } from "../../apps/mobile/lib/tap-to-pay-education";

// Requiring (not importing) the components keeps their "@/..." mobile aliases
// out of the root tsc program: the web tsconfig maps "@/*" to the repo root,
// where the mobile modules don't exist, so a static import would fail the
// project typecheck. Jest resolves the modules at runtime against the mocks
// registered above.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TapToPayAwarenessMoment } =
  require("../../apps/mobile/components/tap-to-pay-awareness") as {
    TapToPayAwarenessMoment: React.ComponentType<{
      session: { pubkey: string } | null;
    }>;
  };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { default: TapToPaySettingsScreen } =
  require("../../apps/mobile/app/(tabs)/settings/tap-to-pay") as {
    default: React.ComponentType;
  };

// The react-native/seller-ui mocks are host-string stand-ins; the renderer's
// types only accept ElementType, so cast once at the lookup sites.
const host = (name: string) => name as unknown as React.ElementType;

type ButtonProps = { label: string; onPress: () => void };
type EducationModalProps = { visible: boolean; onDone: () => void };

const EDUCATION_KEY = tapToPayEducationStorageKey("pk-seller");

function findButton(root: ReactTestInstance, label: string) {
  return root
    .findAllByType(host("ActionButton"))
    .find((b) => (b.props as ButtonProps).label === label);
}

function educationModal(root: ReactTestInstance) {
  return root.findByType(host("TapToPayEducationModal"));
}

function educationModalVisible(root: ReactTestInstance): boolean {
  return (educationModal(root).props as EducationModalProps).visible;
}

function pressEducationDone(root: ReactTestInstance) {
  act(() => {
    (educationModal(root).props as EducationModalProps).onDone();
  });
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  asyncStorageStore.clear();
  jest.clearAllMocks();
  educationSeenBeforeAwarenessDismissed = false;
  mockEnableTapToPay.mockResolvedValue({ ok: true });
});

describe("TapToPayAwarenessMoment education wiring (Apple 4.2)", () => {
  async function renderAndShowAwareness() {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(TapToPayAwarenessMoment, {
          session: { pubkey: "pk-seller" },
        })
      );
    });
    await flush();
    // Eligible, never-shown seller: the awareness modal is up.
    const outerModal = renderer.root.findByType(host("Modal"));
    expect(outerModal.props.visible).toBe(true);
    return renderer;
  }

  it("opens the education modal right after the enable flow's Terms acceptance", async () => {
    const { root } = await renderAndShowAwareness();

    // The education is not up during the pitch.
    expect(educationModalVisible(root)).toBe(false);

    const enableButton = findButton(root, "Turn on Tap to Pay");
    expect(enableButton).toBeDefined();
    await act(async () => {
      (enableButton!.props as ButtonProps).onPress();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });

    // Enable succeeded (Terms accepted natively inside connect): the
    // education modal opened on top of the awareness moment.
    expect(mockEnableTapToPay).toHaveBeenCalledTimes(1);
    expect(educationModalVisible(root)).toBe(true);
    // Not marked seen yet — only dismissal does that.
    expect(asyncStorageStore.get(EDUCATION_KEY)).toBeUndefined();
  });

  it("Done marks the education seen BEFORE the awareness moment dismisses", async () => {
    const { root } = await renderAndShowAwareness();
    await act(async () => {
      (findButton(root, "Turn on Tap to Pay")!.props as ButtonProps).onPress();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    expect(educationModalVisible(root)).toBe(true);

    pressEducationDone(root);
    await flush();

    // The education is persisted for this seller...
    expect(asyncStorageStore.get(EDUCATION_KEY)).toBe("1");
    // ...and it was persisted BEFORE the paused flow resumed (the awareness
    // moment's own dismissal/seen-marker ran strictly after the write).
    expect(educationSeenBeforeAwarenessDismissed).toBe(true);
    // The education closed and the awareness moment dismissed afterwards.
    expect(educationModalVisible(root)).toBe(false);
    expect(root.findByType(host("Modal")).props.visible).toBe(false);
  });

  it("skips the education after enable when the seller already saw it", async () => {
    asyncStorageStore.set(EDUCATION_KEY, "1");
    const { root } = await renderAndShowAwareness();

    await act(async () => {
      (findButton(root, "Turn on Tap to Pay")!.props as ButtonProps).onPress();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });

    expect(mockEnableTapToPay).toHaveBeenCalledTimes(1);
    expect(educationModalVisible(root)).toBe(false);
  });
});

describe("TapToPaySettingsScreen education wiring (Apple 4.2/4.3)", () => {
  function renderSettings() {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(TapToPaySettingsScreen)
      );
    });
    return renderer;
  }

  it("the enable path opens the education right after Terms acceptance, and Done marks it seen", async () => {
    const { root } = renderSettings();
    await flush();
    expect(educationModalVisible(root)).toBe(false);

    const enableButton = findButton(root, "Turn on Tap to Pay");
    expect(enableButton).toBeDefined();
    await act(async () => {
      (enableButton!.props as ButtonProps).onPress();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });

    expect(mockEnableTapToPay).toHaveBeenCalledTimes(1);
    expect(educationModalVisible(root)).toBe(true);
    expect(asyncStorageStore.get(EDUCATION_KEY)).toBeUndefined();

    pressEducationDone(root);
    await flush();

    expect(asyncStorageStore.get(EDUCATION_KEY)).toBe("1");
    expect(educationModalVisible(root)).toBe(false);
  });

  it("'Review the education' reopens the modal anytime (4.3) and Done still marks it seen", async () => {
    const { root } = renderSettings();
    await flush();

    // No enable flow ran — the reopen entry stands alone.
    expect(mockEnableTapToPay).not.toHaveBeenCalled();
    const reviewButton = findButton(root, "Review the education");
    expect(reviewButton).toBeDefined();
    act(() => {
      (reviewButton!.props as ButtonProps).onPress();
    });
    expect(educationModalVisible(root)).toBe(true);

    pressEducationDone(root);
    await flush();

    expect(asyncStorageStore.get(EDUCATION_KEY)).toBe("1");
    expect(educationModalVisible(root)).toBe(false);
  });

  it("skips the education on the enable path when the seller already saw it", async () => {
    asyncStorageStore.set(EDUCATION_KEY, "1");
    const { root } = renderSettings();
    await flush();

    await act(async () => {
      (findButton(root, "Turn on Tap to Pay")!.props as ButtonProps).onPress();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });

    expect(mockEnableTapToPay).toHaveBeenCalledTimes(1);
    expect(educationModalVisible(root)).toBe(false);
  });
});
