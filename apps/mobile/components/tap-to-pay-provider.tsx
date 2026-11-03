import { useCallback, useEffect, useRef, type PropsWithChildren } from "react";
import { AppState } from "react-native";

import type { SellerSession } from "@self-sown/domain";

import {
  createStripeTerminalConnectionToken,
  fetchPosPaymentMethods,
} from "@/lib/pos-api";
import { getStripeTerminalModule } from "@/lib/pos-stripe-terminal";
import { onTerminalSdkInitRequested } from "@/lib/terminal-init-signal";

// Shared Stripe Terminal provider so every Tap to Pay surface (PoS checkout,
// the awareness moment, the Settings enable path) rides one SDK instance
// instead of each screen building its own. When the native module is absent
// (web export, older dev builds) or the seller is signed out, children render
// unwrapped — those surfaces gate their Tap to Pay UI on the module anyway.
// Hoisted: the SDK's internal initialize() callback lists localeConfig in
// its useCallback deps, so an inline object here gives it a new identity on
// every provider render — and init itself toggles the provider's loading
// state, so a failing init used to retrigger the initializer effect on every
// cycle, looping console.error popups (dev LogBox) without any user action.
const TERMINAL_LOCALE_CONFIG = { type: "cardLanguagePreferenceIfAvailable" } as const;

export function TapToPayProvider({
  session,
  children,
}: PropsWithChildren<{ session: SellerSession | null }>) {
  const terminalModule = getStripeTerminalModule();

  const tokenProvider = useCallback(async () => {
    if (!session) throw new Error("No session");
    const token = await createStripeTerminalConnectionToken(session);
    return token.secret;
  }, [session]);

  if (!terminalModule || !session) return <>{children}</>;

  const Provider = terminalModule.StripeTerminalProvider;
  return (
    <Provider
      tokenProvider={tokenProvider}
      logLevel="none"
      localeConfig={TERMINAL_LOCALE_CONFIG}
    >
      {/* The fragment keeps children a single ReactElement (SDK prop
          typing). */}
      <>
        <SdkInitializer module={terminalModule} session={session} />
        {children}
      </>
    </Provider>
  );
}

// Initializes the Terminal SDK once per provider mount, with one retry for a
// transient token/network failure, and re-attempts when the app returns to
// the foreground: connecting Stripe happens in a browser sheet, so the
// foreground event right after connect is when a previously-skipped init
// (charges were disabled) must run — the seller should never have to remount
// a screen for the SDK to come up. Children render immediately: screens that
// don't touch the SDK keep working, and the ones that do (warmup, awareness,
// checkout) poll getIsInitialized() or surface the error on use.
function SdkInitializer({
  module,
  session,
}: {
  module: NonNullable<ReturnType<typeof getStripeTerminalModule>>;
  session: SellerSession;
}) {
  const { initialize, getIsInitialized } = module.useStripeTerminal();

  // The SDK recreates these callbacks whenever provider state flips — init
  // itself toggles `loading` — so depending on them in the effect re-ran the
  // attempt loop once per render; a failing init became an endless
  // console.error LogBox storm with no user action. Refs pin the effect to
  // mount/session/signal/foreground triggers while always calling the latest
  // callbacks.
  const callbacksRef = useRef({ initialize, getIsInitialized });
  callbacksRef.current = { initialize, getIsInitialized };

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    // getIsInitialized can throw while the native side is down; treat a
    // throw as "not initialized" so the foreground retry never dies here.
    const isInitialized = () => {
      try {
        return callbacksRef.current.getIsInitialized();
      } catch {
        return false;
      }
    };

    const attempt = async (retriesLeft: number) => {
      if (inFlight) return;
      inFlight = true;
      let failed = false;
      try {
        // A seller without a charges-enabled Stripe account can never init —
        // the token request 403s (stripe_not_connected) by design. Skip
        // quietly: every Tap to Pay surface already gates on chargesEnabled,
        // and the foreground retry below re-checks after Stripe is
        // connected. A failed methods fetch falls through to a normal init
        // attempt (fail open).
        const methods = await fetchPosPaymentMethods(session).catch(
          () => null
        );
        if (cancelled || isInitialized()) return;
        if (methods && !methods.stripe.chargesEnabled) return;
        // Preflight the connection token: when the SDK's tokenProvider throws
        // inside initialize(), the SDK itself console.errors — a dev-build
        // LogBox popup no catch of ours can intercept — so a refused token
        // (403 not connected, 422 missing business address) must never reach
        // initialize(). Init re-fetches the token anyway; this extra call
        // exists only to keep deterministic refusals silent. The refusal is
        // surfaced properly when the seller presses an enable button
        // (describeTapToPayEnableFailure probes the same endpoint).
        let tokenReady = false;
        try {
          await createStripeTerminalConnectionToken(session);
          tokenReady = true;
        } catch (tokenError) {
          console.warn(
            "Stripe Terminal init skipped — connection token refused:",
            tokenError instanceof Error ? tokenError.message : tokenError
          );
          failed = true;
        }
        if (cancelled || isInitialized() || !tokenReady) return;
        try {
          const result = await callbacksRef.current.initialize();
          if (!result.error) return;
          console.warn("Stripe Terminal init failed:", result.error.message);
        } catch (initError) {
          console.warn("Stripe Terminal init failed:", initError);
        }
        failed = true;
      } finally {
        inFlight = false;
      }
      if (!cancelled && failed && retriesLeft > 0) {
        retryTimer = setTimeout(() => void attempt(retriesLeft - 1), 5_000);
      }
    };

    void attempt(1);
    // The Stripe Connect sheet never backgrounds the app on iOS, so AppState
    // alone can't catch a connect: the connect flow fires this signal after
    // a successful return, waking any provider that skipped init while
    // charges were disabled.
    const unsubscribeInitRequest = onTerminalSdkInitRequested(() => {
      if (!cancelled && !isInitialized()) void attempt(1);
    });
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && !cancelled && !isInitialized()) {
        void attempt(1);
      }
    });
    return () => {
      cancelled = true;
      unsubscribeInitRequest();
      subscription.remove();
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
  }, [session]);

  return null;
}
