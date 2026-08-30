import { Stack } from "expo-router";

import { sellerThemeTokens } from "@/theme/tokens";

export default function ListingsStackLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: sellerThemeTokens.background },
        headerTintColor: sellerThemeTokens.text,
        headerShadowVisible: false,
        contentStyle: { backgroundColor: sellerThemeTokens.background },
      }}
    >
      <Stack.Screen name="index" options={{ title: "Listings" }} />
      <Stack.Screen
        name="new"
        options={{ title: "Create listing", headerBackTitle: "Listings" }}
      />
      <Stack.Screen
        name="[listingId]"
        options={{ title: "Edit listing", headerBackTitle: "Listings" }}
      />
    </Stack>
  );
}
