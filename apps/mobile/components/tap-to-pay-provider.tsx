import { useCallback, useEffect, type PropsWithChildren } from "react";

import type { SellerSession } from "@self-sown/domain";

import { createStripeTerminalConnectionToken } from "@/lib/pos-api";
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
      {/* The provider only exposes initialize() via context — nothing calls
          it on mount — so every SDK method throws until a child does. The
          fragment keeps children a single ReactElement (SDK prop typing). */}
      <>
        <SdkInitializer module={terminalModule} />
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
}: {
  module: NonNullable<ReturnType<typeof getStripeTerminalModule>>;
}) {
  const { initialize } = module.useStripeTerminal();

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const attempt = async (retriesLeft: number) => {
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
  }, [initialize]);

  return null;
}
