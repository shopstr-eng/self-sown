/** @jest-environment node */

// Render test for the SDK initializer inside TapToPayProvider. The init
// policy exists so the raw "First initialize the Stripe Terminal SDK" error
// can never reach a seller:
//
// - A seller without a charges-enabled Stripe account must NOT trigger an
//   init attempt at all: the token request 403s by design, and the failed
//   init's console.error pops a dev-build LogBox over whatever screen
//   mounted the provider (seen when merely navigating to Settings > Tap to
//   Pay before connecting Stripe).
// - Once Stripe is connected, init must kick off WITHOUT waiting for a
//   provider remount — the Sell tab's provider stays mounted across the
//   browser-sheet connect flow, so the dashboard fires
//   requestTerminalSdkInit() on connect return, and an app foreground is a
//   second safety net.
// - The connection token is preflighted before every initialize(): when the
//   tokenProvider throws inside initialize(), the SDK itself console.errors
//   (LogBox popup no catch can intercept), so a refused token must never
//   reach initialize().
// - The attempt loop is pinned to refs: the SDK recreates its context
//   callbacks whenever provider state flips (init toggles `loading`), and
//   depending on them re-ran the effect per render — a failing init looped
//   into an endless LogBox storm with no user action.
//
// Harness pattern mirrors tap-to-pay-settings.test.tsx: virtual host-string
// react-native mocks + require()d component so the "@/..." mobile aliases
// stay out of the root tsc program.

import React from "react";

// AppState mock that lets the test fire foreground events.
type AppStateListener = (state: string) => void;
const appStateListeners = new Set<AppStateListener>();
jest.mock(
  "react-native",
  () => ({
    AppState: {
      addEventListener: (_event: string, listener: AppStateListener) => {
        appStateListeners.add(listener);
        return {
          remove: () => {
            appStateListeners.delete(listener);
          },
        };
      },
    },
  }),
  { virtual: true }
);

// The SDK module stub: initialize tracks calls, getIsInitialized flips only
// when the test says the native side came up.
const mockInitialize = jest.fn(async (..._a: unknown[]) => ({}));
let sdkInitialized = false;
jest.mock(
  "../../lib/pos-stripe-terminal",
  () => {
    // Hoisted: the real getStripeTerminalModule caches its module, so the
    // provider component identity is stable across renders — a fresh object
    // per call would remount the whole subtree (re-running mount effects),
    // which is not the churn this suite simulates.
    const moduleStub = {
      StripeTerminalProvider: (props: { children?: React.ReactNode }) =>
        React.createElement(React.Fragment, null, props.children),
      // Fresh function identities every render, matching the real SDK: its
      // context recreates callbacks whenever provider state flips (init
      // itself toggles `loading`). The initializer must stay pinned to
      // mount/signal/foreground triggers regardless of this churn.
      useStripeTerminal: () => ({
        initialize: (...args: unknown[]) => mockInitialize(...args),
        getIsInitialized: () => sdkInitialized,
      }),
    };
    return { getStripeTerminalModule: () => moduleStub };
  },
  { virtual: true }
);

const mockFetchPosPaymentMethods = jest.fn();
const mockCreateConnectionToken = jest.fn(async (..._a: unknown[]) => ({
  secret: "pst_test",
}));
jest.mock(
  "../../lib/pos-api",
  () => ({
    createStripeTerminalConnectionToken: (...args: unknown[]) =>
      mockCreateConnectionToken(...args),
    fetchPosPaymentMethods: (...args: unknown[]) =>
      mockFetchPosPaymentMethods(...args),
  }),
  { virtual: true }
);

// The REAL signal module — the pub/sub wiring is part of what is under test.
jest.mock(
  "../../lib/terminal-init-signal",
  () => jest.requireActual("../../apps/mobile/lib/terminal-init-signal"),
  { virtual: true }
);

const { render, act } =
  require("@testing-library/react-native") as typeof import("@testing-library/react-native");
const { TapToPayProvider } =
  require("../../apps/mobile/components/tap-to-pay-provider") as {
    TapToPayProvider: (props: {
      session: unknown;
      children?: React.ReactNode;
    }) => React.ReactElement;
  };
const { requestTerminalSdkInit } =
  require("../../apps/mobile/lib/terminal-init-signal") as typeof import("../../apps/mobile/lib/terminal-init-signal");

const session = { pubkey: "pk-seller" } as never;

function setChargesEnabled(enabled: boolean) {
  mockFetchPosPaymentMethods.mockImplementation(async () => ({
    stripe: { connected: enabled, chargesEnabled: enabled },
    square: { connected: false },
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
  appStateListeners.clear();
  sdkInitialized = false;
  setChargesEnabled(true);
});

describe("TapToPayProvider SDK init policy", () => {
  it("does not attempt init while the seller has no charges-enabled Stripe account", async () => {
    setChargesEnabled(false);
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});

    await act(async () => {
      render(
        React.createElement(
          TapToPayProvider,
          { session },
          React.createElement(React.Fragment, null)
        )
      );
    });

    expect(mockInitialize).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("initializes on mount when card charges are enabled", async () => {
    await act(async () => {
      render(
        React.createElement(
          TapToPayProvider,
          { session },
          React.createElement(React.Fragment, null)
        )
      );
    });

    expect(mockInitialize).toHaveBeenCalledTimes(1);
  });

  it("initializes a still-mounted provider when the connect flow fires the init signal", async () => {
    // Mounted before connect: init is skipped because charges are disabled.
    setChargesEnabled(false);
    await act(async () => {
      render(
        React.createElement(
          TapToPayProvider,
          { session },
          React.createElement(React.Fragment, null)
        )
      );
    });
    expect(mockInitialize).not.toHaveBeenCalled();

    // Stripe connect returns with the account now charges-enabled; the
    // dashboard fires the signal and the same provider must initialize.
    setChargesEnabled(true);
    await act(async () => {
      requestTerminalSdkInit();
    });

    expect(mockInitialize).toHaveBeenCalledTimes(1);
  });

  it("retries init on app foreground when still uninitialized", async () => {
    setChargesEnabled(false);
    await act(async () => {
      render(
        React.createElement(
          TapToPayProvider,
          { session },
          React.createElement(React.Fragment, null)
        )
      );
    });
    expect(mockInitialize).not.toHaveBeenCalled();

    setChargesEnabled(true);
    await act(async () => {
      for (const listener of Array.from(appStateListeners)) {
        listener("active");
      }
    });

    expect(mockInitialize).toHaveBeenCalledTimes(1);
  });

  it("does not re-initialize when the signal fires and the SDK is already up", async () => {
    sdkInitialized = true;
    await act(async () => {
      render(
        React.createElement(
          TapToPayProvider,
          { session },
          React.createElement(React.Fragment, null)
        )
      );
    });
    await act(async () => {
      requestTerminalSdkInit();
    });

    expect(mockInitialize).not.toHaveBeenCalled();
  });

  it("skips initialize quietly when the connection-token preflight is refused", async () => {
    mockCreateConnectionToken.mockRejectedValueOnce(
      new Error("Connect a Stripe account with card charges enabled first")
    );
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});

    await act(async () => {
      render(
        React.createElement(
          TapToPayProvider,
          { session },
          React.createElement(React.Fragment, null)
        )
      );
    });

    // The SDK must never see the refusal: its internal tokenProvider catch
    // console.errors, which pops a dev-build LogBox.
    expect(mockInitialize).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("does not re-attempt init when a re-render recreates the SDK callbacks", async () => {
    let app!: Awaited<ReturnType<typeof render>>;
    await act(async () => {
      app = await render(
        React.createElement(
          TapToPayProvider,
          { session },
          React.createElement(React.Fragment, null)
        )
      );
    });
    expect(mockInitialize).toHaveBeenCalledTimes(1);

    await act(async () => {
      await app.rerender(
        React.createElement(
          TapToPayProvider,
          { session },
          React.createElement(React.Fragment, null)
        )
      );
    });

    // The mock hands out a fresh initialize identity every render, as the
    // real SDK does when provider state flips; before the effect was pinned
    // to refs, each churn re-ran the attempt loop — the endless LogBox
    // storm seen whenever init kept failing.
    expect(mockInitialize).toHaveBeenCalledTimes(1);
  });
});
