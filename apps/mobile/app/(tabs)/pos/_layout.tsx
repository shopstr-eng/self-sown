import { Stack } from "expo-router";

import { TapToPayProvider } from "@/components/tap-to-pay-provider";
import { TapToPayWarmup } from "@/components/tap-to-pay-warmup";
import { useSessionStore } from "@/stores/session-store";
import { sellerThemeTokens } from "@/theme/tokens";

export default function PosLayout() {
  const session = useSessionStore((state) => state.session);

  // The provider lives at the PoS stack root so the Stripe Terminal SDK
  // initializes as soon as the Sell tab mounts (Apple checklist 1.5) and all
  // PoS screens — checkout, awareness moment — share one SDK instance.
  return (
    <TapToPayProvider session={session}>
      <TapToPayWarmup session={session} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: sellerThemeTokens.background },
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="cart" />
        <Stack.Screen name="lightning" />
        <Stack.Screen name="square" />
        <Stack.Screen name="card" />
        <Stack.Screen name="success" />
      </Stack>
    </TapToPayProvider>
  );
}
