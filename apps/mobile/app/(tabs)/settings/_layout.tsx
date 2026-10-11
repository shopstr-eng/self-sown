import { Stack } from "expo-router";

import { sellerFonts, sellerThemeTokens } from "@/theme/tokens";

export default function SettingsStackLayout() {
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
      <Stack.Screen name="index" options={{ title: "Settings" }} />
      <Stack.Screen
        name="market-profile"
        options={{ title: "Market profile", headerBackTitle: "Settings" }}
      />
      <Stack.Screen
        name="account"
        options={{ title: "Account", headerBackTitle: "Settings" }}
      />
      <Stack.Screen
        name="addresses"
        options={{ title: "Saved addresses", headerBackTitle: "Settings" }}
      />
    </Stack>
  );
}
