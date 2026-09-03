import { Stack } from "expo-router";

import { sellerThemeTokens } from "@/theme/tokens";

export default function OrdersStackLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: sellerThemeTokens.background },
        headerTintColor: sellerThemeTokens.text,
        headerShadowVisible: false,
        contentStyle: { backgroundColor: sellerThemeTokens.background },
      }}
    >
      <Stack.Screen name="index" options={{ title: "Orders" }} />
      <Stack.Screen
        name="[orderId]"
        options={{ title: "Order details", headerBackTitle: "Orders" }}
      />
    </Stack>
  );
}
