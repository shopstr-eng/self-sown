import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { Text } from "react-native";

import {
  validateSellerListingDraft,
  type SellerListingDraft,
  type SellerListingDraftValidationErrors,
} from "@milk-market/domain";

import { ListingEditor } from "@/components/listing-editor";
import LoadingScreen from "@/components/loading-screen";
import { ScreenScrollView, ScreenTitle } from "@/components/seller-ui";
import {
  findSellerListingDraft,
  useSellerListingEvents,
} from "@/hooks/use-seller-bootstrap";
import { confirmSellerListingDeletion } from "@/lib/confirm-listing-deletion";
import { getErrorMessage } from "@/lib/error-utils";
import { pickAndUploadSellerListingImages } from "@/lib/listing-images";
import {
  removeSellerListing,
  saveSellerListing,
} from "@/lib/seller-listing-actions";
import { useSessionStore } from "@/stores/session-store";
import { sellerThemeTokens } from "@/theme/tokens";

export default function EditListingScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { listingId } = useLocalSearchParams<{ listingId?: string }>();
  const session = useSessionStore((state) => state.session);
  const listingEventsQuery = useSellerListingEvents(session?.pubkey);
  const [draft, setDraft] = useState<SellerListingDraft | null>(null);
  const [errors, setErrors] = useState<SellerListingDraftValidationErrors>({});
  const [saveLoading, setSaveLoading] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [imageLoading, setImageLoading] = useState(false);
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    if (!listingId || !listingEventsQuery.data) {
      return;
    }

    const nextDraft = findSellerListingDraft(
      listingEventsQuery.data,
      listingId
    );
    setDraft((currentDraft) => currentDraft ?? nextDraft);
  }, [listingEventsQuery.data, listingId]);

  if (!session || !listingId) {
    return null;
  }

  if (listingEventsQuery.isLoading && !listingEventsQuery.data) {
    return <LoadingScreen message="Loading listing details..." />;
  }

  if (listingEventsQuery.isError && !listingEventsQuery.data) {
    return (
      <ScreenScrollView>
        <ScreenTitle
          eyebrow="Seller listings"
          title="Listing unavailable"
          description="This listing could not be loaded for editing right now."
        />
        <Text
          style={{
            color: sellerThemeTokens.danger,
            fontSize: 14,
            lineHeight: 20,
          }}
        >
          {getErrorMessage(
            listingEventsQuery.error,
            "Listing details could not be loaded."
          )}
        </Text>
      </ScreenScrollView>
    );
  }

  if (!draft) {
    return (
      <ScreenScrollView>
        <ScreenTitle
          eyebrow="Seller listings"
          title="Listing not found"
          description="This listing no longer appears in the seller cache."
        />
      </ScreenScrollView>
    );
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

  const handlePickImages = async () => {
    setActionError("");
    setImageLoading(true);
    try {
      const { uploadedUrls, failedFileNames } =
        await pickAndUploadSellerListingImages(session);

      if (uploadedUrls.length > 0) {
        setDraft((currentDraft) =>
          currentDraft
            ? {
                ...currentDraft,
                images: Array.from(
                  new Set([...currentDraft.images, ...uploadedUrls])
                ),
              }
            : currentDraft
        );
      }

      if (failedFileNames.length > 0) {
        setActionError(
          "Some selected images could not be uploaded. Successfully uploaded images were kept."
        );
      }
    } catch (caughtError) {
      setActionError(
        caughtError instanceof Error
          ? caughtError.message
          : "Listing images could not be uploaded."
      );
    } finally {
      setImageLoading(false);
    }
  };

  const handleSave = async () => {
    const nextErrors = validateSellerListingDraft(draft);
    setErrors(nextErrors);
    setActionError("");
    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    setSaveLoading(true);
    try {
      await saveSellerListing(session, draft);
      await refreshListings();
      router.replace("/listings?listingMessage=Listing%20updated." as Href);
    } catch (caughtError) {
      setActionError(
        caughtError instanceof Error
          ? caughtError.message
          : "Listing update failed."
      );
    } finally {
      setSaveLoading(false);
    }
  };

  const deleteListing = async () => {
    if (!draft.eventId) {
      setActionError("This listing no longer has an event to delete.");
      return;
    }

    setDeleteLoading(true);
    setActionError("");
    try {
      await removeSellerListing(session, draft.eventId);
      await refreshListings();
      router.replace("/listings?listingMessage=Listing%20deleted." as Href);
    } catch (caughtError) {
      setActionError(
        caughtError instanceof Error
          ? caughtError.message
          : "Listing deletion failed."
      );
    } finally {
      setDeleteLoading(false);
    }
  };

  const handleDelete = () => {
    confirmSellerListingDeletion(() => {
      void deleteListing();
    });
  };

  return (
    <ScreenScrollView>
      <ScreenTitle
        eyebrow="Seller listings"
        title="Edit mobile listing"
        description="Listing edits republish the current event shape with the same listing identity, then retire the previous cached listing event."
      />
      <ListingEditor
        draft={draft}
        errors={errors}
        submitLabel="Save listing changes"
        submitLoading={saveLoading}
        deleteLoading={deleteLoading}
        imageLoading={imageLoading}
        actionError={actionError}
        onChange={(nextDraft) => {
          setDraft(nextDraft);
          setErrors({});
        }}
        onSubmit={handleSave}
        onPickImages={handlePickImages}
        onDelete={handleDelete}
      />
    </ScreenScrollView>
  );
}
