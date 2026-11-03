import { useCallback, useEffect, type PropsWithChildren } from "react";

import type { SellerSession } from "@self-sown/domain";

import {
  createStripeTerminalConnectionToken,
  fetchPosPaymentMethods,
} from "@/lib/pos-api";
import { getStripeTerminalModule } from "@/lib/pos-stripe-terminal";

// Shared Stripe Terminal provider so every Tap to Pay surface (PoS checkout,
// the awareness moment, the Settings enable path) rides one SDK instance
// instead of each screen building its own. When the native module is absent
// (web export, older dev builds) or the seller is signed out, children render
// unwrapped — those surfaces gate their Tap to Pay UI on the module anyway.
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
      localeConfig={{ type: "cardLanguagePreferenceIfAvailable" }}
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
// transient token/network failure. Children render immediately: screens that
// don't touch the SDK keep working, and the ones that do (warmup, awareness,
// checkout) poll getIsInitialized() or surface the error on use.
function SdkInitializer({
  module,
  session,
}: {
  module: NonNullable<ReturnType<typeof getStripeTerminalModule>>;
  session: SellerSession;
}) {
  const { initialize } = module.useStripeTerminal();

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const attempt = async (retriesLeft: number) => {
      // A seller without a charges-enabled Stripe account can never init —
      // the token request 403s (stripe_not_connected) by design, and the
      // failed init's console.error pops a dev-build LogBox over whatever
      // screen mounted the provider (seen when merely navigating to the Tap
      // to Pay settings screen before connecting Stripe). Skip quietly:
      // every Tap to Pay surface already gates on chargesEnabled, and the
      // next provider mount re-checks after Stripe is connected. A failed
      // methods fetch falls through to a normal init attempt (fail open).
      const methods = await fetchPosPaymentMethods(session).catch(() => null);
      if (cancelled) return;
      if (methods && !methods.stripe.chargesEnabled) return;
      try {
        const result = await initialize();
        if (!result.error) return;
        console.error("Stripe Terminal init failed:", result.error.message);
      } catch (initError) {
        console.error("Stripe Terminal init failed:", initError);
      }
      if (!cancelled && retriesLeft > 0) {
        retryTimer = setTimeout(() => void attempt(retriesLeft - 1), 5_000);
      }
    };

    void attempt(1);
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
  }, [initialize, session]);

  return null;
}
