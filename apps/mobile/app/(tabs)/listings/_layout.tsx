import { Stack } from "expo-router";

import { catalogTheme as sellerThemeTokens } from "@/components/catalog-appearance";

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
        options={{ title: "Add product", headerBackTitle: "Listings" }}
      />
      <Stack.Screen
        name="[listingId]"
        options={{ title: "Edit product", headerBackTitle: "Listings" }}
      />
      <Stack.Screen
        name="design/[listingId]"
        options={{ title: "Page design", headerBackTitle: "Product" }}
      />
      <Stack.Screen
        name="design/section/[id]"
        options={{ title: "Section", headerBackTitle: "Back" }}
      />
    </Stack>
  );
}
