import { Stack } from "expo-router";

import { sellerThemeTokens } from "@/theme/tokens";

export const unstable_settings = {
  initialRouteName: "index",
};

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
