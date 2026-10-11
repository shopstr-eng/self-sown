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
      <Stack.Screen
        name="design/index"
        options={{ title: "Stall design", headerBackTitle: "Stall" }}
      />
      <Stack.Screen
        name="design/theme"
        options={{ title: "Theme & colors", headerBackTitle: "Design" }}
      />
      <Stack.Screen
        name="design/navigation"
        options={{ title: "Navigation", headerBackTitle: "Design" }}
      />
      <Stack.Screen
        name="design/sections"
        options={{ title: "Home sections", headerBackTitle: "Design" }}
      />
      <Stack.Screen
        name="design/section/[id]"
        options={{ title: "Edit section", headerBackTitle: "Back" }}
      />
      <Stack.Screen
        name="design/pages"
        options={{ title: "Custom pages", headerBackTitle: "Design" }}
      />
      <Stack.Screen
        name="design/page/[id]"
        options={{ title: "Edit page", headerBackTitle: "Pages" }}
      />
      <Stack.Screen
        name="design/blog-page"
        options={{ title: "Blog page", headerBackTitle: "Design" }}
      />
      <Stack.Screen
        name="design/product-page"
        options={{ title: "Product page", headerBackTitle: "Design" }}
      />
      <Stack.Screen
        name="design/footer"
        options={{ title: "Footer", headerBackTitle: "Design" }}
      />
      <Stack.Screen
        name="design/popup"
        options={{ title: "Email popup", headerBackTitle: "Design" }}
      />
      <Stack.Screen
        name="design/seo"
        options={{ title: "SEO & sharing", headerBackTitle: "Design" }}
      />
    </Stack>
  );
}
