import { Redirect, Tabs, type Href } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { preventListingTabChange } from "@/lib/listing-navigation-guard";
import { usePosOutcomeStore } from "@/lib/pos-outcome-store";

import LoadingScreen from "@/components/loading-screen";
import { useSessionStore } from "@/stores/session-store";
import { sellerFonts, sellerThemeTokens } from "@/theme/tokens";

// Filled glyph when the tab is active, outline when inactive.
function makeTabIcon(
  filled: keyof typeof Ionicons.glyphMap,
  outline: keyof typeof Ionicons.glyphMap
) {
  return function TabIcon({
    color,
    size,
    focused,
  }: {
    color: string;
    size: number;
    focused: boolean;
  }) {
    return (
      <Ionicons name={focused ? filled : outline} color={color} size={size} />
    );
  };
}

export default function SellerTabsLayout() {
  const hydrated = useSessionStore((state) => state.hydrated);
  const session = useSessionStore((state) => state.session);
  // A PoS payment (card, Lightning, or Square) that resolved while the
  // seller was on another tab badges Sell until they return and the payment
  // screen shows the outcome.
  const unseenOutcome = usePosOutcomeStore((state) => state.unseenOutcome);

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
        headerTitleStyle: {
          fontWeight: "800",
          fontFamily: sellerFonts.extrabold,
        },
        headerShadowVisible: false,
        sceneStyle: { backgroundColor: sellerThemeTokens.background },
        tabBarActiveTintColor: sellerThemeTokens.primary,
        tabBarInactiveTintColor: sellerThemeTokens.mutedText,
        tabBarLabelStyle: { fontWeight: "700", fontFamily: sellerFonts.bold },
        tabBarStyle: {
          backgroundColor: sellerThemeTokens.surface,
          borderTopWidth: 2,
          borderTopColor: sellerThemeTokens.black,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Dashboard",
          tabBarLabel: "Dashboard",
          tabBarIcon: makeTabIcon("grid", "grid-outline"),
        }}
      />
      <Tabs.Screen
        name="listings"
        options={{
          title: "Listings",
          tabBarLabel: "Listings",
          headerShown: false,
          tabBarIcon: makeTabIcon("pricetags", "pricetags-outline"),
        }}
      />
      <Tabs.Screen
        name="orders"
        options={{
          title: "Orders",
          tabBarLabel: "Orders",
          headerShown: false,
          tabBarIcon: makeTabIcon("receipt", "receipt-outline"),
        }}
      />
      <Tabs.Screen
        name="pos"
        options={{
          title: "Sell",
          tabBarLabel: "Sell",
          headerShown: false,
          tabBarBadge: unseenOutcome ? "!" : undefined,
          tabBarIcon: makeTabIcon("cart", "cart-outline"),
        }}
      />
      <Tabs.Screen
        name="storefront"
        options={{
          title: "Stall",
          tabBarLabel: "Stall",
          headerShown: false,
          tabBarIcon: makeTabIcon("storefront", "storefront-outline"),
        }}
      />
      <Tabs.Screen
        name="shipping"
        options={{
          title: "Shipping",
          tabBarLabel: "Shipping",
          tabBarIcon: makeTabIcon("cube", "cube-outline"),
        }}
      />
      <Tabs.Screen
        name="assistant"
        options={{
          title: "Assistant",
          tabBarLabel: "Assistant",
          tabBarIcon: makeTabIcon("sparkles", "sparkles-outline"),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          headerShown: false,
          // Reached from the dashboard's settings card, not the tab bar.
          href: null,
        }}
      />
    </Tabs>
  );
}
