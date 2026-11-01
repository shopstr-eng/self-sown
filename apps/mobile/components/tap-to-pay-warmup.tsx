import { useEffect } from "react";
import { AppState } from "react-native";

import type { SellerSession } from "@self-sown/domain";

import { getStripeTerminalModule } from "@/lib/pos-stripe-terminal";
import { runTapToPayWarmup } from "@/lib/pos-tap-to-pay";

// Apple Tap to Pay checklist 1.5/5.6: warm up Tap to Pay when the PoS tab
// mounts and whenever the app returns to the foreground, so the tap UI opens
// in under a second at checkout. Renders nothing; best-effort and silent —
// a failed warmup must never block the sale screens.

// How long to wait for the Stripe Terminal SDK to finish initializing after
// the provider mounts before giving up on this warmup pass. The next
// foreground event or tab visit retries.
const SDK_INIT_WAIT_MS = 15_000;
const SDK_INIT_POLL_MS = 500;

export function TapToPayWarmup({
  session,
}: {
  session: SellerSession | null;
}) {
  const terminalModule = getStripeTerminalModule();
  if (!terminalModule || !session) return null;
  return <WarmupRunner module={terminalModule} />;
}

// Separate component so the module's hook only runs inside the provider.
function WarmupRunner({
  module,
}: {
  module: NonNullable<ReturnType<typeof getStripeTerminalModule>>;
}) {
  const {
    discoverReaders,
    cancelDiscovering,
    supportsReadersOfType,
    getIsInitialized,
  } = module.useStripeTerminal();

  useEffect(() => {
    let cancelled = false;

    const warmup = async () => {
      // SDK methods throw until the provider finishes initializing; poll
      // briefly instead of erroring on the very first mount.
      const deadline = Date.now() + SDK_INIT_WAIT_MS;
      while (!cancelled && !getIsInitialized() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, SDK_INIT_POLL_MS));
      }
      if (cancelled || !getIsInitialized()) return;
      await runTapToPayWarmup({
        discoverReaders,
        cancelDiscovering,
        supportsReadersOfType,
      });
    };

    void warmup();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void warmup();
    });
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [
    discoverReaders,
    cancelDiscovering,
    supportsReadersOfType,
    getIsInitialized,
  ]);

  return null;
}
