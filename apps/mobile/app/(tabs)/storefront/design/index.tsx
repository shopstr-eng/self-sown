import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter, type Href } from "expo-router";
import * as WebBrowser from "expo-web-browser";

import { DesignScreen } from "@/components/design-screen";
import { DesignHint } from "@/components/design-controls";
import { useStorefrontDesignStore } from "@/lib/storefront-design-store";
import { getApiBaseUrl } from "@/lib/api-base-url";
import { sellerFonts, sellerThemeTokens } from "@/theme/tokens";

const DESTINATIONS: {
  href: string;
  title: string;
  description: string;
}[] = [
  {
    href: "/storefront/design/theme",
    title: "Theme & colors",
    description: "Palette, fonts, landing style, and product layout.",
  },
  {
    href: "/storefront/design/navigation",
    title: "Navigation",
    description: "Nav bar colors, layout, links, and optional pages.",
  },
  {
    href: "/storefront/design/sections",
    title: "Home page sections",
    description: "Add, reorder, and edit the sections on your storefront.",
  },
  {
    href: "/storefront/design/pages",
    title: "Custom pages",
    description: "Extra pages (e.g. Wholesale, FAQ) with their own sections.",
  },
  {
    href: "/storefront/design/blog-page",
    title: "Blog page",
    description: "Sections shown on your storefront's blog index.",
  },
  {
    href: "/storefront/design/product-page",
    title: "Product page defaults",
    description: "Sections every product page starts with.",
  },
  {
    href: "/storefront/design/footer",
    title: "Footer",
    description: "Footer text, links, policies, newsletter, and colors.",
  },
  {
    href: "/storefront/design/popup",
    title: "Email popup",
    description: "The discount popup that collects visitor emails.",
  },
  {
    href: "/storefront/design/seo",
    title: "SEO & sharing",
    description: "Search title, description, and social preview image.",
  },
];

export default function DesignHubScreen() {
  const router = useRouter();
  const draft = useStorefrontDesignStore((state) => state.draft);

  const openLivePreview = () => {
    const base = getApiBaseUrl();
    const url = draft.customDomain
      ? `https://${draft.customDomain}`
      : draft.shopSlug
        ? `${base}/stall/${draft.shopSlug}`
        : null;
    if (url) {
      void WebBrowser.openBrowserAsync(url);
    }
  };

  return (
    <DesignScreen
      title="Design your stall"
      description="Everything here edits the same design your web settings control — one save publishes it all."
    >
      <View style={styles.list}>
        {DESTINATIONS.map((destination) => (
          <Pressable
            key={destination.href}
            onPress={() => router.push(destination.href as Href)}
            accessibilityRole="button"
            style={styles.card}
          >
            <Text style={styles.cardTitle}>{destination.title}</Text>
            <Text style={styles.cardDescription}>
              {destination.description}
            </Text>
          </Pressable>
        ))}
        <Pressable
          onPress={openLivePreview}
          accessibilityRole="button"
          style={[styles.card, styles.previewCard]}
        >
          <Text style={[styles.cardTitle, styles.previewCardTitle]}>
            Preview live stall
          </Text>
          <Text style={[styles.cardDescription, styles.previewCardDescription]}>
            Opens your published storefront in an in-app browser. Save first to
            see your latest edits.
          </Text>
        </Pressable>
        {!draft.shopSlug && !draft.customDomain ? (
          <DesignHint text="Set a stall address on the Stall tab first to enable preview." />
        ) : null}
      </View>
    </DesignScreen>
  );
}

const styles = StyleSheet.create({
  list: { gap: 10 },
  card: {
    borderWidth: 2,
    borderColor: sellerThemeTokens.black,
    borderRadius: 6,
    backgroundColor: sellerThemeTokens.surface,
    padding: 14,
    gap: 4,
  },
  previewCard: { backgroundColor: sellerThemeTokens.primary },
  previewCardTitle: { color: "#FFFFFF" },
  previewCardDescription: { color: "#DCE8E2" },
  cardTitle: {
    color: sellerThemeTokens.text,
    fontSize: 16,
    fontFamily: sellerFonts.extrabold,
  },
  cardDescription: {
    color: sellerThemeTokens.mutedText,
    fontSize: 13,
    fontFamily: sellerFonts.regular,
    lineHeight: 18,
  },
});
