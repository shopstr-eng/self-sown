import AsyncStorage from "@react-native-async-storage/async-storage";
// Type-only import: erased at runtime, so this module stays loadable in
// builds/tests where the native Stripe Terminal module is absent.
import type { Reader } from "@stripe/stripe-terminal-react-native";

import type { SellerSession } from "@self-sown/domain";

import {
  fetchPosPaymentMethods,
  isStripeNotConnectedError,
} from "@/lib/pos-api";

// Apple Tap to Pay on iPhone enablement UX (Apple review checklist v1.8):
// warmup (1.5/5.6), one-time awareness moment (3.1-3.3), a Settings enable
// path (3.6), and a checkout button that leads straight into Apple's Terms &
// Conditions on first use (5.3, via the Stripe SDK's connect flow). This
// module holds the testable logic; the Stripe Terminal module itself stays
// behind lib/pos-stripe-terminal.ts so web/older dev builds never touch it.
//
// Req 1.6: whether the merchant has accepted Apple's T&Cs is owned by Apple /
// the PSP SDK — we never persist an "enabled" flag. The only thing stored
// locally is that the awareness moment has been shown, keyed per seller
// pubkey so a shared device shows it once per account.

const AWARENESS_STORAGE_PREFIX = "tapToPay:awareness";
const AWARENESS_SEEN_VALUE = "1";

export function tapToPayAwarenessStorageKey(pubkey: string): string {
  return `${AWARENESS_STORAGE_PREFIX}:${pubkey}`;
}

export async function hasSeenTapToPayAwareness(
  pubkey: string
): Promise<boolean> {
  try {
    return (
      (await AsyncStorage.getItem(tapToPayAwarenessStorageKey(pubkey))) ===
      AWARENESS_SEEN_VALUE
    );
  } catch {
    // Storage hiccup: fail open so the seller still sees the moment.
    return false;
  }
}

export async function markTapToPayAwarenessSeen(pubkey: string): Promise<void> {
  try {
    await AsyncStorage.setItem(
      tapToPayAwarenessStorageKey(pubkey),
      AWARENESS_SEEN_VALUE
    );
  } catch {
    // Worst case the moment shows once more — acceptable.
  }
}

// A seller is eligible for Tap to Pay when the native module shipped in this
// build, their Stripe account can take card charges, and this device supports
// Tap to Pay (iPhone XS+, checked via the SDK). Ineligible sellers never see
// the awareness moment, the checkout button, or the Settings entry.
export function computeTapToPayEligibility(input: {
  moduleAvailable: boolean;
  chargesEnabled: boolean;
  deviceSupported: boolean;
}): boolean {
  return input.moduleAvailable && input.chargesEnabled && input.deviceSupported;
}

// Minimal structural views of the Stripe Terminal SDK methods the flows use,
// so the logic is unit-testable without the native module.
type ResultWithError = { error?: { message?: string } };

// Method-shorthand signatures (bivariant params) so the SDK's own narrowly
// typed functions assign to these without casts at the call sites.
export type TapToPaySupportProbe = {
  supportsReadersOfType(params: {
    deviceType: "tapToPay";
    discoveryMethod: "tapToPay";
  }): Promise<{
    readerSupportResult?: boolean;
    error?: { message?: string };
  }>;
};

export type TapToPayWarmupTerminal = TapToPaySupportProbe & {
  discoverReaders(params: {
    discoveryMethod: "tapToPay";
    simulated: boolean;
  }): Promise<ResultWithError>;
  cancelDiscovering(): Promise<unknown>;
};

export type TapToPayEnableTerminal = {
  // Matches the SDK: resolves to the connected reader or null.
  getConnectedReader(): Promise<Reader.Type | null>;
  discoverReaders(params: {
    discoveryMethod: "tapToPay";
    simulated: boolean;
  }): Promise<ResultWithError>;
  getLocations(
    params: Record<string, never>
  ): Promise<ResultWithError & { locations?: { id?: string }[] }>;
  connectReader(params: {
    discoveryMethod: "tapToPay";
    reader: Reader.Type;
    locationId: string;
    merchantDisplayName: string;
    tosAcceptancePermitted: boolean;
  }): Promise<ResultWithError>;
};

export const TAP_TO_PAY_UNSUPPORTED_MESSAGE =
  "Tap to Pay isn't available on this device. It needs an iPhone XS or newer.";
export const TAP_TO_PAY_NO_LOCATION_MESSAGE =
  "No Stripe Terminal location found on your account. Create one in the Stripe Dashboard under Terminal, then try again.";
export const TAP_TO_PAY_CONNECT_STRIPE_MESSAGE =
  "Connect a Stripe account with card charges to use Tap to Pay.";
export const TAP_TO_PAY_STARTING_UP_MESSAGE =
  "Tap to Pay is still starting up. Try again in a moment.";

// The Stripe Terminal SDK rejects every method with this opaque message when
// initialize() failed upstream — usually because the tokenProvider's
// connection-token request was refused (403 stripe_not_connected for a seller
// with no charges-enabled account). Never show it verbatim to sellers.
const SDK_NOT_INITIALIZED_PATTERN = /first initialize the stripe terminal sdk/i;

// Translates an enablement failure into seller-actionable copy. The SDK
// swallows the tokenProvider's stripe_not_connected 403 into its generic
// not-initialized error, so on that error we re-check the seller's payment
// methods to tell "connect Stripe first" apart from a transient init race.
export async function describeTapToPayEnableFailure(
  session: SellerSession,
  raw: unknown
): Promise<{ message: string; needsStripeConnect: boolean }> {
  if (isStripeNotConnectedError(raw)) {
    return {
      message: TAP_TO_PAY_CONNECT_STRIPE_MESSAGE,
      needsStripeConnect: true,
    };
  }
  const message =
    raw instanceof Error ? raw.message : typeof raw === "string" ? raw : "";
  if (SDK_NOT_INITIALIZED_PATTERN.test(message)) {
    const methods = await fetchPosPaymentMethods(session).catch(() => null);
    if (methods && !methods.stripe.chargesEnabled) {
      return {
        message: TAP_TO_PAY_CONNECT_STRIPE_MESSAGE,
        needsStripeConnect: true,
      };
    }
    return {
      message: TAP_TO_PAY_STARTING_UP_MESSAGE,
      needsStripeConnect: false,
    };
  }
  return {
    message: message || "Could not enable Tap to Pay.",
    needsStripeConnect: false,
  };
}

export async function checkTapToPayDeviceSupport(
  terminal: TapToPaySupportProbe
): Promise<boolean> {
  try {
    const result = await terminal.supportsReadersOfType({
      deviceType: "tapToPay",
      discoveryMethod: "tapToPay",
    });
    return result.readerSupportResult === true;
  } catch {
    // SDK still initializing or bridge failure: report unsupported rather
    // than throwing — callers treat this as "not eligible right now".
    return false;
  }
}

// Warmup (Req 1.5/5.6): preparing Tap to Pay means a throwaway reader
// discovery, which wakes Apple's PaymentCardReader stack so the tap UI opens
// in under a second at checkout. Single-flight module-wide so a foreground
// event during an in-flight warmup (or a seller hammering the PoS tab) never
// stacks discoveries — and so the checkout flow can await the in-flight
// warmup instead of colliding with it.
let warmupInFlight: Promise<{ supported: boolean }> | null = null;

export function runTapToPayWarmup(
  terminal: TapToPayWarmupTerminal,
  options?: { discoveryTimeoutMs?: number }
): Promise<{ supported: boolean }> {
  if (warmupInFlight) return warmupInFlight;
  const run = (async () => {
    const supported = await checkTapToPayDeviceSupport(terminal);
    if (!supported) return { supported: false };
    const discoveryTimeoutMs = options?.discoveryTimeoutMs ?? 10_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        terminal.discoverReaders({
          discoveryMethod: "tapToPay",
          simulated: false,
        }),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), discoveryTimeoutMs);
        }),
      ]);
    } catch {
      // Best-effort: a failed warmup must never surface to the seller.
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      await terminal.cancelDiscovering().catch(() => {});
    }
    return { supported: true };
  })();
  warmupInFlight = run;
  void run.finally(() => {
    if (warmupInFlight === run) warmupInFlight = null;
  });
  return run;
}

// Checkout presses the Tap to Pay button while a warmup discovery may still
// be running; starting a second discovery would error, so the sale flow
// awaits the pending warmup first.
export function awaitPendingTapToPayWarmup(): Promise<unknown> {
  return warmupInFlight ?? Promise.resolve();
}

export type TapToPayEnablePhase = "discovering" | "connecting";

// Enablement (Req 3.5/3.6/5.3): discovery + connect. The first tapToPay
// connect makes the Stripe SDK present Apple's Tap to Pay Terms & Conditions
// natively; accepting completes enablement. Used by the awareness modal, the
// Settings path, and mirrored by the checkout charge flow.
export async function enableTapToPay(
  terminal: TapToPayEnableTerminal,
  getDiscoveredReaders: () => Reader.Type[],
  onPhase?: (phase: TapToPayEnablePhase) => void
): Promise<{ ok: boolean; error?: string }> {
  // The native SDK keeps the Tap to Pay connection alive across provider
  // mounts. A connected reader means terms were already accepted and the
  // device is ready — reuse it instead of forcing a second discovery, which
  // would collide with the live connection and error.
  try {
    if (await terminal.getConnectedReader()) return { ok: true };
  } catch {
    // Unknown connection state: fall through to a fresh discovery.
  }

  onPhase?.("discovering");
  const discovered = await terminal.discoverReaders({
    discoveryMethod: "tapToPay",
    simulated: false,
  });
  if (discovered.error) {
    return {
      ok: false,
      error: discovered.error.message ?? "Tap to Pay discovery failed.",
    };
  }
  const reader = getDiscoveredReaders()[0];
  if (!reader) {
    return { ok: false, error: TAP_TO_PAY_UNSUPPORTED_MESSAGE };
  }

  // Tap to Pay connections require a Terminal location on the seller's
  // connected account (SDK contract, beta.34: locationId is required).
  const locations = await terminal.getLocations({});
  const locationId = locations.error ? undefined : locations.locations?.[0]?.id;
  if (!locationId) {
    return { ok: false, error: TAP_TO_PAY_NO_LOCATION_MESSAGE };
  }

  onPhase?.("connecting");
  const connected = await terminal.connectReader({
    discoveryMethod: "tapToPay",
    reader,
    locationId,
    merchantDisplayName: "Self-sown PoS",
    tosAcceptancePermitted: true,
  });
  if (connected.error) {
    return {
      ok: false,
      error: connected.error.message ?? "Could not enable Tap to Pay.",
    };
  }
  return { ok: true };
}
