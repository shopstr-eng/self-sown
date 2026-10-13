import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";

import {
  ActionButton,
  ScreenScrollView,
  ScreenTitle,
} from "@/components/seller-ui";
import { useSellerListingEvents } from "@/hooks/use-seller-bootstrap";
import { useProductPageDesignStore } from "@/lib/product-page-design-store";
import { useSessionStore } from "@/stores/session-store";
import { sellerFonts, sellerThemeTokens } from "@/theme/tokens";

// Shared chrome for the per-product page design screens (hub + section
// editor): hydrates the product design store from the listing's raw event
// (the page_config tag), then renders the editor plus the save bar. Saving
// republishes the listing event with the new page_config — see
// product-page-design-store.
export function ProductDesignScreen({
  listingId,
  title,
  description,
  children,
}: {
  listingId: string;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  const session = useSessionStore((state) => state.session);
  const eventsQuery = useSellerListingEvents(session?.pubkey);
  const queryClient = useQueryClient();

  const hydrate = useProductPageDesignStore((state) => state.hydrate);
  const save = useProductPageDesignStore((state) => state.save);
  const dirty = useProductPageDesignStore((state) => state.dirty);
  const saving = useProductPageDesignStore((state) => state.saving);
  const saveError = useProductPageDesignStore((state) => state.saveError);
  const saveMessage = useProductPageDesignStore((state) => state.saveMessage);

  const event = eventsQuery.data?.find(
    (entry) =>
      entry.id === listingId &&
      entry.kind === 30402 &&
      entry.pubkey === session?.pubkey
  );

  useEffect(() => {
    if (event) hydrate(event);
  }, [event, hydrate]);

  if (eventsQuery.isLoading && !eventsQuery.data) {
    return (
      <View style={styles.loadingWrap}>
        <ActivityIndicator color={sellerThemeTokens.primary} size="large" />
      </View>
    );
  }

  if (eventsQuery.isError && !eventsQuery.data) {
    return (
      <ScreenScrollView>
        <ScreenTitle
          eyebrow="Product design"
          title={title}
          description="Your listings could not be loaded. Check your connection and try again."
        />
        <ActionButton
          label="Retry"
          onPress={() => void eventsQuery.refetch()}
          variant="secondary"
        />
      </ScreenScrollView>
    );
  }

  if (!event) {
    return (
      <ScreenScrollView>
        <ScreenTitle
          eyebrow="Product design"
          title="Listing not found"
          description="This product is no longer available. It may have been deleted on another device."
        />
      </ScreenScrollView>
    );
  }

  const handleSave = () => {
    if (!session) return;
    void save(session).then((ok) => {
      if (ok) {
        void queryClient.invalidateQueries({
          queryKey: ["seller-listing-events", session.pubkey],
        });
        void queryClient.invalidateQueries({
          queryKey: ["seller-listings", session.pubkey],
        });
      }
    });
  };

  return (
    <ScreenScrollView>
      <ScreenTitle
        eyebrow="Product design"
        title={title}
        description={description}
      />
      {children}
      <View style={styles.saveBar}>
        {saveError ? <Text style={styles.saveError}>{saveError}</Text> : null}
        {saveMessage ? (
          <Text style={styles.saveMessage}>{saveMessage}</Text>
        ) : null}
        <ActionButton
          label={saving ? "Saving…" : dirty ? "Save page design" : "Saved"}
          disabled={saving || !dirty}
          onPress={handleSave}
        />
      </View>
    </ScreenScrollView>
  );
}

const styles = StyleSheet.create({
  loadingWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: sellerThemeTokens.background,
  },
  saveBar: {
    marginTop: 20,
    gap: 8,
    paddingTop: 16,
    borderTopWidth: 2,
    borderTopColor: sellerThemeTokens.black,
  },
  saveError: {
    color: "#c0392b",
    fontSize: 13,
    fontFamily: sellerFonts.regular,
  },
  saveMessage: {
    color: sellerThemeTokens.primary,
    fontSize: 13,
    fontFamily: sellerFonts.bold,
  },
});
