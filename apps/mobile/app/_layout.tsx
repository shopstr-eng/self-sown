import { Stack } from "expo-router";
import {
  useFonts,
  Poppins_400Regular,
  Poppins_600SemiBold,
  Poppins_700Bold,
  Poppins_800ExtraBold,
} from "@expo-google-fonts/poppins";

import { SellerActivityBridge } from "@/components/seller-activity-bridge";
import { AppProviders } from "@/components/app-providers";
import LoadingScreen from "@/components/loading-screen";
import { sellerFonts, sellerThemeTokens } from "@/theme/tokens";

export { ErrorBoundary } from "expo-router";

export const unstable_settings = {
  initialRouteName: "(tabs)",
};

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Poppins_400Regular,
    Poppins_600SemiBold,
    Poppins_700Bold,
    Poppins_800ExtraBold,
  });

  if (!fontsLoaded) {
    return <LoadingScreen message="Loading..." />;
  }

  return (
    <AppProviders>
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
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen
          name="sign-in"
          options={{ title: "Vendor Sign In", headerBackTitle: "Back" }}
        />
        <Stack.Screen
          name="email-auth"
          options={{ title: "Email Access", headerBackTitle: "Back" }}
        />
        <Stack.Screen
          name="nsec-import"
          options={{ title: "Import nsec", headerBackTitle: "Back" }}
        />
        <Stack.Screen
          name="nsec-create"
          options={{ title: "Create seller key", headerBackTitle: "Back" }}
        />
        <Stack.Screen
          name="phase-one-check"
          options={{ title: "Phase 1 Check", headerBackTitle: "Back" }}
        />
        <Stack.Screen
          name="stripe-connect-return"
          options={{ title: "Stripe Connect", headerShown: false }}
        />
      </Stack>
      <SellerActivityBridge />
    </AppProviders>
  );
}
