import { useMemo, useState } from "react";
import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { StyleSheet, Text } from "react-native";

import { selectSellerListingSummaries } from "@milk-market/domain";

import {
  ActionButton,
  EmptyState,
  ScreenScrollView,
  ScreenTitle,
  SellerCard,
} from "@/components/seller-ui";
import { ListingCard } from "@/components/listing-card";
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
      <ScreenScrollView catalog>
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
    <ScreenScrollView catalog>
      <ScreenTitle
        eyebrow="Seller listings"
        title="Your products"
        description="Keep your catalog ready for customers."
      />

      {listingEventsQuery.isError ? (
        <SellerCard
          title="Showing saved products"
          description="Refresh failed. Your saved catalog is still available."
        >
          <ActionButton
            label="Retry refresh"
            variant="secondary"
            onPress={() => {
              void listingEventsQuery.refetch();
            }}
          />
        </SellerCard>
      ) : null}
      {listingMessage ? (
        <Text style={styles.successText}>{listingMessage}</Text>
      ) : null}
      {actionMessage ? (
        <Text style={styles.successText}>{actionMessage}</Text>
      ) : null}
      {actionError ? <Text style={styles.errorText}>{actionError}</Text> : null}

      <ActionButton
        label="Add product"
        onPress={() => router.push("/listings/new" as Href)}
      />

      {!listings.length ? (
        <EmptyState
          title="No seller listings yet"
          description="Add your first product with photos, prices and available options."
        />
      ) : (
        listings.map((listing) => (
          <ListingCard
            key={listing.id}
            listing={listing}
            imageUrl={
              listingEventsQuery.data
                ?.find((event) => event.id === listing.id)
                ?.tags.find((tag) => tag[0] === "image")?.[1]
            }
            busyAction={busyListingId === listing.id ? busyAction : ""}
            onEdit={() => router.push(`/listings/${listing.id}` as Href)}
            onToggleStatus={() => {
              void handleStatusToggle(listing.id);
            }}
            onDelete={() =>
              confirmSellerListingDeletion(() => {
                void handleDelete(listing.id);
              })
            }
          />
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
