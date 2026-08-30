import { useMemo, useState } from "react";
import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { StyleSheet, Text, View } from "react-native";

import { selectSellerListingSummaries } from "@milk-market/domain";

import {
  ActionButton,
  EmptyState,
  ScreenScrollView,
  ScreenTitle,
  SellerCard,
  StatusPill,
} from "@/components/seller-ui";
import LoadingScreen from "@/components/loading-screen";
import { useSellerListingEvents } from "@/hooks/use-seller-bootstrap";
import { confirmSellerListingDeletion } from "@/lib/confirm-listing-deletion";
import { getErrorMessage } from "@/lib/error-utils";
import {
  removeSellerListing,
  updateSellerListingStatus,
} from "@/lib/seller-listing-actions";
import { useSessionStore } from "@/stores/session-store";
import { sellerThemeTokens } from "@/theme/tokens";

export default function ListingsIndexScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { listingMessage } = useLocalSearchParams<{
    listingMessage?: string;
  }>();
  const session = useSessionStore((state) => state.session);
  const listingEventsQuery = useSellerListingEvents(session?.pubkey);
  const [actionError, setActionError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [busyListingId, setBusyListingId] = useState("");
  const [busyAction, setBusyAction] = useState<"delete" | "status" | "">("");

  const listings = useMemo(() => {
    if (!session || !listingEventsQuery.data) {
      return [];
    }

    return selectSellerListingSummaries(
      listingEventsQuery.data,
      session.pubkey
    );
  }, [listingEventsQuery.data, session]);

  if (!session) {
    return null;
  }

  if (listingEventsQuery.isLoading && !listingEventsQuery.data) {
    return <LoadingScreen message="Loading seller listings..." />;
  }

  const refreshListings = async () => {
    await Promise.allSettled([
      queryClient.invalidateQueries({
        queryKey: ["seller-listing-events", session.pubkey],
      }),
      queryClient.invalidateQueries({
        queryKey: ["seller-listings", session.pubkey],
      }),
    ]);
  };

  const handleDelete = async (listingId: string) => {
    const event = listingEventsQuery.data?.find(
      (listingEvent) => listingEvent.id === listingId
    );
    if (!event) {
      setActionError("That listing could not be found anymore.");
      return;
    }

    setActionError("");
    setActionMessage("");
    setBusyListingId(listingId);
    setBusyAction("delete");
    try {
      await removeSellerListing(session, event.id);
      await refreshListings();
      setActionMessage("Listing deleted.");
    } catch (caughtError) {
      setActionError(getErrorMessage(caughtError, "Listing deletion failed."));
    } finally {
      setBusyListingId("");
      setBusyAction("");
    }
  };

  const handleStatusToggle = async (listingId: string) => {
    const event = listingEventsQuery.data?.find(
      (listingEvent) => listingEvent.id === listingId
    );
    if (!event) {
      setActionError("That listing could not be found anymore.");
      return;
    }

    const nextStatus =
      listings.find((listing) => listing.id === listingId)?.status === "active"
        ? "inactive"
        : "active";

    setActionError("");
    setActionMessage("");
    setBusyListingId(listingId);
    setBusyAction("status");
    try {
      await updateSellerListingStatus({
        event,
        nextStatus,
        session,
      });
      await refreshListings();
      setActionMessage(
        nextStatus === "active"
          ? "Listing marked active."
          : "Listing marked inactive."
      );
    } catch (caughtError) {
      setActionError(
        getErrorMessage(caughtError, "Listing status could not be updated.")
      );
    } finally {
      setBusyListingId("");
      setBusyAction("");
    }
  };

  if (listingEventsQuery.isError && !listingEventsQuery.data) {
    return (
      <ScreenScrollView>
        <ScreenTitle
          eyebrow="Seller listings"
          title="Listings unavailable"
          description="Seller inventory could not be loaded yet."
        />
        <SellerCard title="Could not load seller listings">
          <Text style={styles.errorText}>
            {getErrorMessage(
              listingEventsQuery.error,
              "Seller listings could not be loaded right now."
            )}
          </Text>
          <ActionButton
            label="Retry listings"
            onPress={async () => {
              await listingEventsQuery.refetch();
            }}
            variant="secondary"
            loading={listingEventsQuery.isFetching}
          />
        </SellerCard>
      </ScreenScrollView>
    );
  }

  return (
    <ScreenScrollView>
      <ScreenTitle
        eyebrow="Seller listings"
        title="Manage mobile inventory"
        description="Phase 3 turns the seller listings tab into a mobile-native CRUD flow built on the same Nostr listing model as the web app."
      />

      {listingMessage ? (
        <Text style={styles.successText}>{listingMessage}</Text>
      ) : null}
      {actionMessage ? (
        <Text style={styles.successText}>{actionMessage}</Text>
      ) : null}
      {actionError ? <Text style={styles.errorText}>{actionError}</Text> : null}

      <ActionButton
        label="Create listing"
        onPress={() => router.push("/listings/new" as Href)}
      />

      {!listings.length ? (
        <EmptyState
          title="No seller listings yet"
          description="Create your first mobile listing to publish it through the shared Milk Market product event model."
        />
      ) : (
        listings.map((listing) => (
          <SellerCard
            key={listing.id}
            title={listing.title}
            description={`Primary category: ${listing.primaryCategory ?? "Uncategorized"}`}
          >
            <View style={styles.rowBetween}>
              <Text style={styles.metaLabel}>Status</Text>
              <StatusPill
                tone={listing.status === "active" ? "success" : "warning"}
                label={listing.status}
              />
            </View>
            <View style={styles.rowBetween}>
              <Text style={styles.metaLabel}>Price</Text>
              <Text style={styles.metaValue}>
                {listing.price === null || !listing.currency
                  ? "No price tag"
                  : `${listing.price.toFixed(2)} ${listing.currency}`}
              </Text>
            </View>
            <View style={styles.rowBetween}>
              <Text style={styles.metaLabel}>Created</Text>
              <Text style={styles.metaValue}>
                {new Date(listing.createdAt * 1000).toLocaleDateString()}
              </Text>
            </View>
            <View style={styles.buttonGroup}>
              <ActionButton
                label="Edit"
                onPress={() => router.push(`/listings/${listing.id}` as Href)}
                variant="secondary"
              />
              <ActionButton
                label={
                  listing.status === "active" ? "Mark inactive" : "Mark active"
                }
                onPress={() => handleStatusToggle(listing.id)}
                variant="secondary"
                loading={
                  busyListingId === listing.id && busyAction === "status"
                }
              />
              <ActionButton
                label="Delete"
                onPress={() =>
                  confirmSellerListingDeletion(() => {
                    void handleDelete(listing.id);
                  })
                }
                variant="secondary"
                loading={
                  busyListingId === listing.id && busyAction === "delete"
                }
              />
            </View>
          </SellerCard>
        ))
      )}
    </ScreenScrollView>
  );
}

const styles = StyleSheet.create({
  rowBetween: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
    alignItems: "center",
  },
  metaLabel: {
    color: sellerThemeTokens.mutedText,
    fontSize: 13,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.7,
  },
  metaValue: {
    color: sellerThemeTokens.text,
    fontSize: 15,
    fontWeight: "600",
  },
  buttonGroup: {
    gap: 10,
  },
  errorText: {
    color: sellerThemeTokens.danger,
    fontSize: 14,
    lineHeight: 20,
  },
  successText: {
    color: sellerThemeTokens.success,
    fontSize: 14,
    lineHeight: 20,
  },
});
