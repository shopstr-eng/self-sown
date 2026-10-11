import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter, type Href } from "expo-router";

import {
  AddItemButton,
  DesignHint,
  ListItemChrome,
} from "@/components/design-controls";
import { DesignScreen } from "@/components/design-screen";
import { SellerCard } from "@/components/seller-ui";
import { useStorefrontDesignStore } from "@/lib/storefront-design-store";
import { sellerFonts, sellerThemeTokens } from "@/theme/tokens";

let pageCounter = 0;

export function createPageId(): string {
  pageCounter += 1;
  return `page-${Date.now().toString(36)}-${pageCounter}`;
}

export default function PagesListScreen() {
  const router = useRouter();
  const pages = useStorefrontDesignStore((state) => state.draft.pages ?? []);
  const update = useStorefrontDesignStore((state) => state.update);

  return (
    <DesignScreen
      title="Custom pages"
      description="Extra pages on your storefront — each gets its own sections. Link them from Navigation."
    >
      <SellerCard>
        {pages.length === 0 ? (
          <DesignHint text="No custom pages yet — add one below." />
        ) : null}
        {pages.map((page, index) => (
          <ListItemChrome
            key={page.id}
            title={page.title || "Untitled page"}
            subtitle={`/${page.slug}`}
            isFirst={index === 0}
            isLast={index === pages.length - 1}
            onDelete={() =>
              update((current) => ({
                ...current,
                pages: (current.pages ?? []).filter(
                  (entry) => entry.id !== page.id
                ),
              }))
            }
          >
            <Pressable
              onPress={() =>
                router.push(`/storefront/design/page/${page.id}` as Href)
              }
              accessibilityRole="button"
              style={styles.editButton}
            >
              <Text style={styles.editButtonText}>Edit page</Text>
            </Pressable>
          </ListItemChrome>
        ))}
        <AddItemButton
          label="Add page"
          onPress={() => {
            const id = createPageId();
            update((current) => ({
              ...current,
              pages: [
                ...(current.pages ?? []),
                {
                  id,
                  title: "New page",
                  slug: `page-${(current.pages ?? []).length + 1}`,
                  sections: [],
                },
              ],
            }));
            router.push(`/storefront/design/page/${id}` as Href);
          }}
        />
        <View>
          <DesignHint text="Deleting a page here also removes any nav links pointing at it when you next edit Navigation." />
        </View>
      </SellerCard>
    </DesignScreen>
  );
}

const styles = StyleSheet.create({
  editButton: {
    alignSelf: "flex-start",
    borderWidth: 2,
    borderColor: sellerThemeTokens.black,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: sellerThemeTokens.primary,
  },
  editButtonText: {
    color: "#ffffff",
    fontFamily: sellerFonts.bold,
    fontSize: 13,
  },
});
