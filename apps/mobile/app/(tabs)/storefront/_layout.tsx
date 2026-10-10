import { Stack } from "expo-router";

import { sellerFonts, sellerThemeTokens } from "@/theme/tokens";

export default function StorefrontStackLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: sellerThemeTokens.background },
        headerTintColor: sellerThemeTokens.text,
        headerTitleStyle: {
          fontWeight: "800",
          fontFamily: sellerFonts.extrabold,
        },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: sellerThemeTokens.background },
      }}
    >
      <Stack.Screen name="index" options={{ title: "Stall" }} />
      <Stack.Screen
        name="discounts"
        options={{ title: "Discount codes", headerBackTitle: "Stall" }}
      />
      <Stack.Screen
        name="email-flows"
        options={{ title: "Email flows", headerBackTitle: "Stall" }}
      />
      <Stack.Screen
        name="blog"
        options={{ title: "Blog", headerBackTitle: "Stall" }}
      />
      <Stack.Screen
        name="community"
        options={{ title: "Communities", headerBackTitle: "Stall" }}
      />
    </Stack>
  );
}
