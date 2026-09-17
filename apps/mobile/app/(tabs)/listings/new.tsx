import { useListingEditorNavigation } from "@/hooks/use-listing-editor-navigation";
import { listingHasUnsavedChanges } from "@/lib/listing-editor-state";
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter, type Href } from "expo-router";

import {
  createEmptySellerListingDraft,
  validateSellerListingDraft,
  type SellerListingDraftValidationErrors,
  type SellerListingDraft,
} from "@milk-market/domain";
import { createSellerListingDTag } from "@milk-market/nostr";

import { ListingEditor } from "@/components/listing-editor";
import { ScreenScrollView, ScreenTitle } from "@/components/seller-ui";
import { pickAndUploadSellerListingImages } from "@/lib/listing-images";
import { saveSellerListing } from "@/lib/seller-listing-actions";
import { useSessionStore } from "@/stores/session-store";

export default function NewListingScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const session = useSessionStore((state) => state.session);
  const [draft, setDraft] = useState<SellerListingDraft>(
    createEmptySellerListingDraft
  );
  const [errors, setErrors] = useState<SellerListingDraftValidationErrors>({});
  const [saveLoading, setSaveLoading] = useState(false);
  const [imageLoading, setImageLoading] = useState(false);
  const [actionError, setActionError] = useState("");
  const initialDraft = useRef(draft);
  const allowNavigation = useListingEditorNavigation(
    listingHasUnsavedChanges(draft, initialDraft.current),
    saveLoading || imageLoading
  );

  if (!session) {
    return null;
  }

  const handlePickImages = async () => {
    setActionError("");
    setImageLoading(true);
    try {
      const { uploadedUrls, failedFileNames } =
        await pickAndUploadSellerListingImages(session);

      if (uploadedUrls.length > 0) {
        setDraft((currentDraft) => ({
          ...currentDraft,
          images: Array.from(
            new Set([...currentDraft.images, ...uploadedUrls])
          ),
        }));
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
      const draftToSave = draft.dTag
        ? draft
        : { ...draft, dTag: createSellerListingDTag() };
      setDraft(draftToSave);
      await saveSellerListing(session, draftToSave);
      await Promise.allSettled([
        queryClient.invalidateQueries({
          queryKey: ["seller-listing-events", session.pubkey],
        }),
        queryClient.invalidateQueries({
          queryKey: ["seller-listings", session.pubkey],
        }),
      ]);
      allowNavigation(() =>
        router.replace("/listings?listingMessage=Listing%20published." as Href)
      );
    } catch (caughtError) {
      setActionError(
        caughtError instanceof Error
          ? caughtError.message
          : "Listing publish failed."
      );
    } finally {
      setSaveLoading(false);
    }
  };

  return (
    <ScreenScrollView catalog adjustForKeyboard>
      <ScreenTitle
        eyebrow="Seller listings"
        title="Add product"
        description="Add photos, prices and the options your customers can choose."
      />
      <ListingEditor
        draft={draft}
        errors={errors}
        submitLabel="Publish product"
        submitLoading={saveLoading}
        imageLoading={imageLoading}
        actionError={actionError}
        onChange={(nextDraft) => {
          setDraft(nextDraft);
          setErrors({});
        }}
        onSubmit={handleSave}
        onPickImages={handlePickImages}
      />
    </ScreenScrollView>
  );
}
