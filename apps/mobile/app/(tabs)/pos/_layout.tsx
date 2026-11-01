import { Stack } from "expo-router";

import { sellerThemeTokens } from "@/theme/tokens";

export default function PosLayout() {
  return (
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
  );
}
