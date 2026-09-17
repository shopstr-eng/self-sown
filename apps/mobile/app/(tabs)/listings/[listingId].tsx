import { useListingEditorNavigation } from "@/hooks/use-listing-editor-navigation";
import { listingHasUnsavedChanges } from "@/lib/listing-editor-state";
import { useEffect, useRef, useState } from "react";
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
  const initialDraft = useRef<SellerListingDraft | null>(null);
  const allowNavigation = useListingEditorNavigation(
    listingHasUnsavedChanges(draft, initialDraft.current),
    saveLoading || deleteLoading || imageLoading
  );

  useEffect(() => {
    if (!listingId || !listingEventsQuery.data) {
      return;
    }

    const nextDraft = findSellerListingDraft(
      listingEventsQuery.data,
      listingId
    );
    if (nextDraft && nextDraft.sourcePubkey !== session?.pubkey) return;
    if (!initialDraft.current && nextDraft)
      initialDraft.current = JSON.parse(JSON.stringify(nextDraft));
    setDraft((currentDraft) => currentDraft ?? nextDraft);
  }, [listingEventsQuery.data, listingId, session?.pubkey]);

  if (!session || !listingId) {
    return null;
  }

  if (listingEventsQuery.isLoading && !listingEventsQuery.data) {
    return <LoadingScreen message="Loading listing details..." />;
  }

  if (listingEventsQuery.isError && !listingEventsQuery.data) {
    return (
      <ScreenScrollView catalog>
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
      <ScreenScrollView catalog>
        <ScreenTitle
          eyebrow="Seller listings"
          title="Listing not found"
          description="This product is no longer available. Return to your catalog and refresh."
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
      setActionError("Review the highlighted fields above before saving.");
      return;
    }

    setSaveLoading(true);
    try {
      await saveSellerListing(session, draft);
      await refreshListings();
      allowNavigation(() =>
        router.replace("/listings?listingMessage=Listing%20updated." as Href)
      );
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
      allowNavigation(() =>
        router.replace("/listings?listingMessage=Listing%20deleted." as Href)
      );
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
    <ScreenScrollView catalog adjustForKeyboard>
      <ScreenTitle
        eyebrow="Seller listings"
        title="Edit product"
        description="Update your product details, prices and available options."
      />
      <ListingEditor
        draft={draft}
        errors={errors}
        submitLabel="Save changes"
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
