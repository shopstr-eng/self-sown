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

// Host-component stand-ins: behaviour lives in props/handlers, not in native
// rendering. StyleSheet.create is the identity; StyleSheet.flatten must exist
// because @testing-library/react-native reads it internally. virtual: true so
// the mock also intercepts RNTL's own require("react-native"), which resolves
// to a pnpm peer-context path a non-virtual mock never matches.
jest.mock(
  "react-native",
  () => ({
    Modal: "Modal",
    View: "View",
    Text: "Text",
    Image: "Image",
    StyleSheet: {
      create: (styles: unknown) => styles,
      flatten: (style: unknown) => style,
    },
  }),
  { virtual: true }
);

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

// Requiring (not importing) @testing-library/react-native keeps the
// jest.mock("react-native", ...) registration above in effect when RNTL
// loads: the next/jest SWC transform does NOT hoist jest.mock calls above
// static ESM imports, and RNTL requires the real (ESM, untransformed)
// react-native at module load, which would crash before the mock registers.
// NOTE: RNTL v14's exported `screen` is a placeholder proxy that render()
// REPLACES, so never destructure it — use the render() result's queries.
const { render, act, fireEvent } =
  require("@testing-library/react-native") as typeof import("@testing-library/react-native");

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

type RenderResult = Awaited<ReturnType<typeof render>>;

// The host-node type `container.queryAll` returns. The concrete TestInstance
// class comes from RNTL's nested `test-renderer` package, which the root tsc
// program cannot import by name, so derive it from the render result
// instead. (A hand-written structural type does NOT work: fireEvent requires
// the real TestInstance, which has private members.)
type HostNode = RenderResult["container"];

const EDUCATION_KEY = tapToPayEducationStorageKey("pk-seller");

// The current render, refreshed by every render call below. RNTL's auto
// cleanup unmounts after each test, so tests only ever see their own tree.
let app: RenderResult;

function hostNodesOfType(name: string): HostNode[] {
  return app.container.queryAll((node) => node.type === name);
}

function findButton(label: string): HostNode | undefined {
  return hostNodesOfType("ActionButton").find((b) => b.props.label === label);
}

async function pressButton(label: string) {
  const button = findButton(label);
  expect(button).toBeDefined();
  await fireEvent.press(button!);
  await flush();
}

function educationModal(): HostNode {
  const modals = hostNodesOfType("TapToPayEducationModal");
  expect(modals).toHaveLength(1);
  return modals[0]!;
}

function educationModalVisible(): boolean {
  return educationModal().props.visible;
}

async function pressEducationDone() {
  const modal = educationModal();
  await act(() => {
    modal.props.onDone();
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
    app = await render(
      React.createElement(TapToPayAwarenessMoment, {
        session: { pubkey: "pk-seller" },
      })
    );
    await flush();
    // Eligible, never-shown seller: the awareness modal is up.
    const outerModals = hostNodesOfType("Modal");
    expect(outerModals).toHaveLength(1);
    expect(outerModals[0]!.props.visible).toBe(true);
  }

  it("opens the education modal right after the enable flow's Terms acceptance", async () => {
    await renderAndShowAwareness();

    // The education is not up during the pitch.
    expect(educationModalVisible()).toBe(false);

    await pressButton("Turn on Tap to Pay");

    // Enable succeeded (Terms accepted natively inside connect): the
    // education modal opened on top of the awareness moment.
    expect(mockEnableTapToPay).toHaveBeenCalledTimes(1);
    expect(educationModalVisible()).toBe(true);
    // Not marked seen yet — only dismissal does that.
    expect(asyncStorageStore.get(EDUCATION_KEY)).toBeUndefined();
  });

  it("Done marks the education seen BEFORE the awareness moment dismisses", async () => {
    await renderAndShowAwareness();
    await pressButton("Turn on Tap to Pay");
    expect(educationModalVisible()).toBe(true);

    await pressEducationDone();
    await flush();

    // The education is persisted for this seller...
    expect(asyncStorageStore.get(EDUCATION_KEY)).toBe("1");
    // ...and it was persisted BEFORE the paused flow resumed (the awareness
    // moment's own dismissal/seen-marker ran strictly after the write).
    expect(educationSeenBeforeAwarenessDismissed).toBe(true);
    // The education closed and the awareness moment dismissed afterwards.
    expect(educationModalVisible()).toBe(false);
    expect(hostNodesOfType("Modal")[0]!.props.visible).toBe(false);
  });

  it("skips the education after enable when the seller already saw it", async () => {
    asyncStorageStore.set(EDUCATION_KEY, "1");
    await renderAndShowAwareness();

    await pressButton("Turn on Tap to Pay");

    expect(mockEnableTapToPay).toHaveBeenCalledTimes(1);
    expect(educationModalVisible()).toBe(false);
  });
});

describe("TapToPaySettingsScreen education wiring (Apple 4.2/4.3)", () => {
  async function renderSettings() {
    app = await render(React.createElement(TapToPaySettingsScreen));
  }

  it("the enable path opens the education right after Terms acceptance, and Done marks it seen", async () => {
    await renderSettings();
    await flush();
    expect(educationModalVisible()).toBe(false);

    await pressButton("Turn on Tap to Pay");

    expect(mockEnableTapToPay).toHaveBeenCalledTimes(1);
    expect(educationModalVisible()).toBe(true);
    expect(asyncStorageStore.get(EDUCATION_KEY)).toBeUndefined();

    await pressEducationDone();
    await flush();

    expect(asyncStorageStore.get(EDUCATION_KEY)).toBe("1");
    expect(educationModalVisible()).toBe(false);
  });

  it("'Review the education' reopens the modal anytime (4.3) and Done still marks it seen", async () => {
    await renderSettings();
    await flush();

    // No enable flow ran — the reopen entry stands alone.
    expect(mockEnableTapToPay).not.toHaveBeenCalled();
    await pressButton("Review the education");
    expect(educationModalVisible()).toBe(true);

    await pressEducationDone();
    await flush();

    expect(asyncStorageStore.get(EDUCATION_KEY)).toBe("1");
    expect(educationModalVisible()).toBe(false);
  });

  it("skips the education on the enable path when the seller already saw it", async () => {
    asyncStorageStore.set(EDUCATION_KEY, "1");
    await renderSettings();
    await flush();

    await pressButton("Turn on Tap to Pay");

    expect(mockEnableTapToPay).toHaveBeenCalledTimes(1);
    expect(educationModalVisible()).toBe(false);
  });
});
