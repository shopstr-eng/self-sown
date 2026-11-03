/** @jest-environment node */

// Apple Tap to Pay enablement UX logic (checklist v1.8): eligibility gate,
// once-per-seller awareness persistence, warmup single-flight/cancellation,
// and the discover → location → connect enablement flow that surfaces Apple's
// Terms & Conditions via the Stripe SDK.

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

// pos-tap-to-pay consults the seller's payment methods to tell a
// not-connected Stripe account (the connection-token 403) apart from a
// transient SDK init race. The "@/lib/pos-api" alias rewrites to a
// root-relative specifier, so the virtual mock keys at the path as seen from
// this test file; the handle is pulled lazily below to dodge TDZ at import.
jest.mock(
  "../../lib/pos-api",
  () => ({
    fetchPosPaymentMethods: jest.fn(),
    isStripeNotConnectedError: (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "stripe_not_connected",
  }),
  { virtual: true }
);

import {
  TAP_TO_PAY_CONNECT_STRIPE_MESSAGE,
  TAP_TO_PAY_NO_LOCATION_MESSAGE,
  TAP_TO_PAY_STARTING_UP_MESSAGE,
  TAP_TO_PAY_UNSUPPORTED_MESSAGE,
  awaitPendingTapToPayWarmup,
  checkTapToPayDeviceSupport,
  computeTapToPayEligibility,
  describeTapToPayEnableFailure,
  enableTapToPay,
  hasSeenTapToPayAwareness,
  markTapToPayAwarenessSeen,
  runTapToPayWarmup,
  tapToPayAwarenessStorageKey,
  type TapToPayEnableTerminal,
} from "../../apps/mobile/lib/pos-tap-to-pay";

const mockFetchPosPaymentMethods = jest.requireMock("../../lib/pos-api")
  .fetchPosPaymentMethods as jest.Mock;

// The SDK package only resolves inside apps/mobile (pnpm, unhoisted), so
// derive the reader type from the lib's exported contract instead of a
// direct @stripe import.
type ReaderType = Parameters<
  TapToPayEnableTerminal["connectReader"]
>[0]["reader"];

beforeEach(() => {
  asyncStorageStore.clear();
  jest.clearAllMocks();
});

describe("computeTapToPayEligibility", () => {
  it("requires the module, card charges, and device support together", () => {
    expect(
      computeTapToPayEligibility({
        moduleAvailable: true,
        chargesEnabled: true,
        deviceSupported: true,
      })
    ).toBe(true);
    expect(
      computeTapToPayEligibility({
        moduleAvailable: false,
        chargesEnabled: true,
        deviceSupported: true,
      })
    ).toBe(false);
    expect(
      computeTapToPayEligibility({
        moduleAvailable: true,
        chargesEnabled: false,
        deviceSupported: true,
      })
    ).toBe(false);
    expect(
      computeTapToPayEligibility({
        moduleAvailable: true,
        chargesEnabled: true,
        deviceSupported: false,
      })
    ).toBe(false);
  });
});

describe("awareness persistence", () => {
  it("is scoped per seller pubkey and shown until marked seen", async () => {
    await expect(hasSeenTapToPayAwareness("pk-a")).resolves.toBe(false);
    await markTapToPayAwarenessSeen("pk-a");
    await expect(hasSeenTapToPayAwareness("pk-a")).resolves.toBe(true);
    // A shared device must not hide the moment from the next account.
    await expect(hasSeenTapToPayAwareness("pk-b")).resolves.toBe(false);
    expect(tapToPayAwarenessStorageKey("pk-a")).not.toBe(
      tapToPayAwarenessStorageKey("pk-b")
    );
  });
});

function warmupTerminal(overrides?: {
  supported?: boolean;
  discoveryError?: string;
  discoveryDelayMs?: number;
}) {
  const supported = overrides?.supported ?? true;
  return {
    supportsReadersOfType: jest.fn(async () =>
      supported
        ? { readerSupportResult: true as const }
        : { error: { message: "unsupported" } }
    ),
    discoverReaders: jest.fn(async () => {
      if (overrides?.discoveryDelayMs) {
        await new Promise((resolve) =>
          setTimeout(resolve, overrides.discoveryDelayMs)
        );
      }
      return overrides?.discoveryError
        ? { error: { message: overrides.discoveryError } }
        : {};
    }),
    cancelDiscovering: jest.fn(async () => ({})),
  };
}

describe("checkTapToPayDeviceSupport", () => {
  it("returns false instead of throwing when the SDK is not ready", async () => {
    const terminal = {
      supportsReadersOfType: jest.fn(async () => {
        throw new Error("First initialize the Stripe Terminal SDK");
      }),
    };
    await expect(checkTapToPayDeviceSupport(terminal)).resolves.toBe(false);
  });
});

describe("runTapToPayWarmup", () => {
  it("discovers then cancels discovery on a supported device", async () => {
    const terminal = warmupTerminal();
    await expect(runTapToPayWarmup(terminal)).resolves.toEqual({
      supported: true,
    });
    expect(terminal.supportsReadersOfType).toHaveBeenCalledWith({
      deviceType: "tapToPay",
      discoveryMethod: "tapToPay",
    });
    expect(terminal.discoverReaders).toHaveBeenCalledWith({
      discoveryMethod: "tapToPay",
      simulated: false,
    });
    expect(terminal.cancelDiscovering).toHaveBeenCalledTimes(1);
  });

  it("skips discovery entirely on unsupported devices", async () => {
    const terminal = warmupTerminal({ supported: false });
    await expect(runTapToPayWarmup(terminal)).resolves.toEqual({
      supported: false,
    });
    expect(terminal.discoverReaders).not.toHaveBeenCalled();
    expect(terminal.cancelDiscovering).not.toHaveBeenCalled();
  });

  it("swallows discovery errors and still cancels discovering", async () => {
    const terminal = warmupTerminal({ discoveryError: "location off" });
    await expect(runTapToPayWarmup(terminal)).resolves.toEqual({
      supported: true,
    });
    expect(terminal.cancelDiscovering).toHaveBeenCalledTimes(1);
  });

  it("cancels a stuck discovery once the timeout hits", async () => {
    const terminal = warmupTerminal({ discoveryDelayMs: 500 });
    await expect(
      runTapToPayWarmup(terminal, { discoveryTimeoutMs: 50 })
    ).resolves.toEqual({ supported: true });
    expect(terminal.cancelDiscovering).toHaveBeenCalledTimes(1);
  });

  it("is single-flight: concurrent calls share one discovery", async () => {
    const terminal = warmupTerminal({ discoveryDelayMs: 30 });
    const first = runTapToPayWarmup(terminal);
    const second = runTapToPayWarmup(terminal);
    expect(second).toBe(first);
    await expect(first).resolves.toEqual({ supported: true });
    expect(terminal.discoverReaders).toHaveBeenCalledTimes(1);
    // After it settles, the checkout path has nothing to wait on.
    await expect(awaitPendingTapToPayWarmup()).resolves.toBeUndefined();
  });

  it("lets checkout await an in-flight warmup before discovering", async () => {
    const terminal = warmupTerminal({ discoveryDelayMs: 30 });
    const pending = runTapToPayWarmup(terminal);
    await expect(awaitPendingTapToPayWarmup()).resolves.toEqual({
      supported: true,
    });
    await pending;
  });
});

// The SDK's Reader.Type has required native fields; tests only need identity.
function fakeReader(id: string): ReaderType {
  return { id } as unknown as ReaderType;
}

function enableTerminal(overrides?: {
  connectedReader?: ReaderType;
  connectedReaderThrows?: boolean;
  discoveryError?: string;
  locationError?: boolean;
  connectError?: string;
}) {
  return {
    getConnectedReader: jest.fn(async () => {
      if (overrides?.connectedReaderThrows) {
        throw new Error("state unknown");
      }
      return overrides?.connectedReader ?? null;
    }),
    discoverReaders: jest.fn(async () =>
      overrides?.discoveryError
        ? { error: { message: overrides.discoveryError } }
        : {}
    ),
    getLocations: jest.fn(async () =>
      overrides?.locationError
        ? { error: { message: "no auth" } }
        : { locations: [{ id: "loc_123" }] }
    ),
    connectReader: jest.fn(async () =>
      overrides?.connectError
        ? { error: { message: overrides.connectError } }
        : {}
    ),
  };
}

describe("enableTapToPay", () => {
  it("discovers, resolves a location, then connects with ToS acceptance permitted", async () => {
    const terminal = enableTerminal();
    const reader = fakeReader("ttp_reader");
    const phases: string[] = [];
    const result = await enableTapToPay(
      terminal,
      () => [reader],
      (phase) => phases.push(phase)
    );
    expect(result).toEqual({ ok: true });
    expect(phases).toEqual(["discovering", "connecting"]);
    expect(terminal.connectReader).toHaveBeenCalledWith(
      expect.objectContaining({
        discoveryMethod: "tapToPay",
        reader,
        locationId: "loc_123",
        tosAcceptancePermitted: true,
      })
    );
  });

  it("fails loudly when the device has no Tap to Pay reader", async () => {
    const terminal = enableTerminal();
    const result = await enableTapToPay(terminal, () => []);
    expect(result).toEqual({
      ok: false,
      error: TAP_TO_PAY_UNSUPPORTED_MESSAGE,
    });
    expect(terminal.connectReader).not.toHaveBeenCalled();
  });

  it("surfaces discovery errors before touching locations", async () => {
    const terminal = enableTerminal({ discoveryError: "bluetooth off" });
    const result = await enableTapToPay(terminal, () => [fakeReader("r")]);
    expect(result).toEqual({ ok: false, error: "bluetooth off" });
    expect(terminal.getLocations).not.toHaveBeenCalled();
  });

  it("requires a Terminal location before connecting", async () => {
    const terminal = enableTerminal({ locationError: true });
    const result = await enableTapToPay(terminal, () => [fakeReader("r")]);
    expect(result).toEqual({
      ok: false,
      error: TAP_TO_PAY_NO_LOCATION_MESSAGE,
    });
    expect(terminal.connectReader).not.toHaveBeenCalled();
  });

  it("reports a declined Terms & Conditions acceptance as an error", async () => {
    const terminal = enableTerminal({
      connectError: "Tap to Pay terms were declined",
    });
    const result = await enableTapToPay(terminal, () => [fakeReader("r")]);
    expect(result).toEqual({
      ok: false,
      error: "Tap to Pay terms were declined",
    });
  });

  it("short-circuits when a Tap to Pay reader is already connected", async () => {
    const terminal = enableTerminal({
      connectedReader: fakeReader("ttp_live"),
    });
    const result = await enableTapToPay(terminal, () => []);
    expect(result).toEqual({ ok: true });
    // A second discovery would collide with the live connection.
    expect(terminal.discoverReaders).not.toHaveBeenCalled();
    expect(terminal.connectReader).not.toHaveBeenCalled();
  });

  it("falls through to discovery when the connection state is unreadable", async () => {
    const terminal = enableTerminal({ connectedReaderThrows: true });
    const result = await enableTapToPay(terminal, () => [fakeReader("r")]);
    expect(result).toEqual({ ok: true });
    expect(terminal.discoverReaders).toHaveBeenCalledTimes(1);
    expect(terminal.connectReader).toHaveBeenCalledTimes(1);
  });
});

describe("describeTapToPayEnableFailure", () => {
  // SellerSession's full shape is irrelevant here — the resolver only passes
  // it through to the (mocked) payment-methods fetch.
  const session = { pubkey: "pk-seller" } as never;

  beforeEach(() => {
    mockFetchPosPaymentMethods.mockReset();
  });

  it("maps a stripe_not_connected API error straight to the connect-Stripe action", async () => {
    const error = Object.assign(
      new Error("Connect a Stripe account with card charges enabled first"),
      { code: "stripe_not_connected" }
    );
    const result = await describeTapToPayEnableFailure(session, error);
    expect(result).toEqual({
      message: TAP_TO_PAY_CONNECT_STRIPE_MESSAGE,
      needsStripeConnect: true,
    });
    // No re-check needed: the server already said the account is missing.
    expect(mockFetchPosPaymentMethods).not.toHaveBeenCalled();
  });

  it("treats the raw SDK not-initialized error as connect-Stripe when card charges are disabled", async () => {
    // The SDK swallows the connection-token 403 into its generic init error,
    // so the resolver re-checks the account and finds charges disabled.
    mockFetchPosPaymentMethods.mockResolvedValue({
      stripe: { connected: false, chargesEnabled: false },
      square: { connected: false },
    });
    const result = await describeTapToPayEnableFailure(
      session,
      new Error(
        "First initialize the Stripe Terminal SDK before performing any action"
      )
    );
    expect(result).toEqual({
      message: TAP_TO_PAY_CONNECT_STRIPE_MESSAGE,
      needsStripeConnect: true,
    });
  });

  it("maps the not-initialized error to a retry hint when card charges are live", async () => {
    mockFetchPosPaymentMethods.mockResolvedValue({
      stripe: { connected: true, chargesEnabled: true },
      square: { connected: false },
    });
    const result = await describeTapToPayEnableFailure(
      session,
      new Error(
        "First initialize the Stripe Terminal SDK before performing any action"
      )
    );
    expect(result).toEqual({
      message: TAP_TO_PAY_STARTING_UP_MESSAGE,
      needsStripeConnect: false,
    });
  });

  it("still hides the raw SDK error when the payment-methods re-check fails", async () => {
    mockFetchPosPaymentMethods.mockRejectedValue(new Error("offline"));
    const result = await describeTapToPayEnableFailure(
      session,
      new Error(
        "First initialize the Stripe Terminal SDK before performing any action"
      )
    );
    expect(result.message).toBe(TAP_TO_PAY_STARTING_UP_MESSAGE);
    expect(result.message).not.toMatch(/first initialize/i);
  });

  it("passes other enable errors through unchanged", async () => {
    const result = await describeTapToPayEnableFailure(
      session,
      new Error("Tap to Pay terms were declined")
    );
    expect(result).toEqual({
      message: "Tap to Pay terms were declined",
      needsStripeConnect: false,
    });
    expect(mockFetchPosPaymentMethods).not.toHaveBeenCalled();
  });

  it("falls back to a generic message for empty failures", async () => {
    const result = await describeTapToPayEnableFailure(session, undefined);
    expect(result).toEqual({
      message: "Could not enable Tap to Pay.",
      needsStripeConnect: false,
    });
  });
});
