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
          headerStyle: { backgroundColor: sellerThemeTokens.background },
          headerTintColor: sellerThemeTokens.text,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: sellerThemeTokens.background },
        }}
      >
        {/* The Sell landing screen shows the native header (like Orders and
            Listings) so the page gets the same header + top spacing as the
            other tabs; the checkout flow screens stay headerless. */}
        <Stack.Screen
          name="index"
          options={{ headerShown: true, title: "Sell" }}
        />
        <Stack.Screen name="cart" />
        <Stack.Screen name="lightning" />
        <Stack.Screen name="square" />
        <Stack.Screen name="card" />
        <Stack.Screen name="success" />
      </Stack>
    </TapToPayProvider>
  );
}
