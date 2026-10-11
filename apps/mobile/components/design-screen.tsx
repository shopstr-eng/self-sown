import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";

import {
  ActionButton,
  ScreenScrollView,
  ScreenTitle,
} from "@/components/seller-ui";
import { useSellerProfile } from "@/hooks/use-seller-bootstrap";
import { useStorefrontDesignStore } from "@/lib/storefront-design-store";
import { useSessionStore } from "@/stores/session-store";
import { sellerFonts, sellerThemeTokens } from "@/theme/tokens";

// Shared chrome for every design editor screen: hydrates the shared draft
// store from the seller's profile once, then renders the editor plus the
// save bar. Saving publishes the whole storefront config as one kind:30019
// event (see storefront-design-store).
export function DesignScreen({
  eyebrow = "Stall design",
  title,
  description,
  children,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  const session = useSessionStore((state) => state.session);
  const profileQuery = useSellerProfile(session?.pubkey);
  const hydrate = useStorefrontDesignStore((state) => state.hydrate);
  const queryClient = useQueryClient();

  const storefront = profileQuery.data?.content.storefront;

  useEffect(() => {
    if (profileQuery.data) {
      hydrate(storefront);
    }
  }, [profileQuery.data, storefront, hydrate]);

  const dirty = useStorefrontDesignStore((state) => state.dirty);
  const saving = useStorefrontDesignStore((state) => state.saving);
  const saveError = useStorefrontDesignStore((state) => state.saveError);
  const saveMessage = useStorefrontDesignStore((state) => state.saveMessage);
  const save = useStorefrontDesignStore((state) => state.save);

  if (profileQuery.isLoading) {
    return (
      <View style={styles.loadingWrap}>
        <ActivityIndicator color={sellerThemeTokens.primary} size="large" />
      </View>
    );
  }

  if (profileQuery.isError) {
    return (
      <ScreenScrollView>
        <ScreenTitle
          eyebrow={eyebrow}
          title={title}
          description="Your stall profile could not be loaded. Check your connection and try again."
        />
        <ActionButton
          label="Retry"
          onPress={() => void profileQuery.refetch()}
          variant="secondary"
        />
      </ScreenScrollView>
    );
  }

  return (
    <ScreenScrollView>
      <ScreenTitle eyebrow={eyebrow} title={title} description={description} />
      {children}
      <View style={styles.saveBar}>
        {saveError ? <Text style={styles.saveError}>{saveError}</Text> : null}
        {saveMessage ? (
          <Text style={styles.saveMessage}>{saveMessage}</Text>
        ) : null}
        <ActionButton
          label={saving ? "Saving…" : dirty ? "Save design" : "Saved"}
          disabled={saving || !dirty}
          onPress={() => {
            if (!session) return;
            void save({
              session,
              existingContent: profileQuery.data?.content,
            }).then((ok) => {
              if (ok) {
                void queryClient.invalidateQueries({
                  queryKey: ["seller-profile", session.pubkey],
                });
              }
            });
          }}
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
