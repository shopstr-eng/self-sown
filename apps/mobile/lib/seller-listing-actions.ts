import {
  createSellerListingDraftFromEvent,
  type NostrEventRecord,
  type SellerListingDraft,
  type SellerSession,
} from "@milk-market/domain";
import { deleteSellerListing, publishSellerListing } from "@milk-market/nostr";

import { getApiBaseUrl } from "@/lib/api-base-url";

export async function saveSellerListing(
  session: SellerSession,
  draft: SellerListingDraft
) {
  return publishSellerListing({
    baseUrl: getApiBaseUrl(),
    session,
    draft,
    existingEventId: draft.eventId,
    existingDTag: draft.dTag,
  });
}

export async function removeSellerListing(
  session: SellerSession,
  eventId: string
) {
  return deleteSellerListing({
    baseUrl: getApiBaseUrl(),
    session,
    eventId,
  });
}

export async function updateSellerListingStatus(params: {
  event: NostrEventRecord;
  nextStatus: SellerListingDraft["status"];
  session: SellerSession;
}) {
  const draft = createSellerListingDraftFromEvent(params.event);
  if (!draft) {
    throw new Error("Listing details could not be loaded.");
  }

  return saveSellerListing(params.session, {
    ...draft,
    status: params.nextStatus,
  });
}
