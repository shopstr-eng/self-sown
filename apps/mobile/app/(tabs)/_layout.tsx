import { Redirect, Tabs, type Href } from "expo-router";

import { preventListingTabChange } from "@/lib/listing-navigation-guard";

import LoadingScreen from "@/components/loading-screen";
import { useSessionStore } from "@/stores/session-store";
import { sellerThemeTokens } from "@/theme/tokens";

export default function SellerTabsLayout() {
  const hydrated = useSessionStore((state) => state.hydrated);
  const session = useSessionStore((state) => state.session);

  if (!hydrated) {
    return <LoadingScreen message="Loading seller workspace..." />;
  }

  if (!session) {
    return <Redirect href={"/sign-in" as Href} />;
  }

  return (
    <Tabs
      screenListeners={({ navigation }) => ({
        tabPress: (event) => {
          const state = navigation.getState();
          if (event.target === state.routes[state.index]?.key) return;
          const route = state.routes.find((item) => item.key === event.target);
          if (
            route &&
            preventListingTabChange(() => navigation.navigate(route.name))
          ) {
            event.preventDefault();
          }
        },
      })}
      screenOptions={{
        headerStyle: { backgroundColor: sellerThemeTokens.background },
        headerTintColor: sellerThemeTokens.text,
        headerShadowVisible: false,
        sceneStyle: { backgroundColor: sellerThemeTokens.background },
        tabBarActiveTintColor: sellerThemeTokens.primary,
        tabBarInactiveTintColor: sellerThemeTokens.mutedText,
        tabBarStyle: { backgroundColor: sellerThemeTokens.surface },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Dashboard",
          tabBarLabel: "Dashboard",
        }}
      />
      <Tabs.Screen
        name="listings"
        options={{
          title: "Listings",
          tabBarLabel: "Listings",
          headerShown: false,
        }}
      />
      <Tabs.Screen
        name="orders"
        options={{
          title: "Orders",
          tabBarLabel: "Orders",
          headerShown: false,
        }}
      />
      <Tabs.Screen
        name="storefront"
        options={{
          title: "Stall",
          tabBarLabel: "Stall",
        }}
      />
      <Tabs.Screen
        name="shipping"
        options={{
          title: "Shipping",
          tabBarLabel: "Shipping",
        }}
      />
    </Tabs>
  );
}
