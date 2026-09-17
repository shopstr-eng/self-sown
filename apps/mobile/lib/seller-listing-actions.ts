import {
  createSellerListingDraftFromEvent,
  type NostrEventRecord,
  type SellerListingDraft,
  type SellerSession,
} from "@milk-market/domain";
import { deleteSellerListing, publishSellerListing } from "@milk-market/nostr";

import { getApiBaseUrl } from "@/lib/api-base-url";
import { mobileApiClient } from "@/lib/api-client";
import { assertSellerListingEditable } from "./listing-editor-state";

const pendingSellers = new Set<string>();
async function catalogMutation<T>(
  session: SellerSession,
  operation: () => Promise<T>
): Promise<T> {
  if (pendingSellers.has(session.pubkey))
    throw new Error("Wait for the current product change to finish.");
  pendingSellers.add(session.pubkey);
  try {
    return await operation();
  } finally {
    pendingSellers.delete(session.pubkey);
  }
}

export async function saveSellerListing(
  session: SellerSession,
  draft: SellerListingDraft
) {
  return catalogMutation(session, async () => {
    const events = draft.eventId
      ? await mobileApiClient.fetchProducts(session.pubkey)
      : [];
    assertSellerListingEditable(session.pubkey, draft, events);
    return publishSellerListing({
      baseUrl: getApiBaseUrl(),
      session,
      draft,
      existingEventId: draft.eventId,
      existingDTag: draft.eventId ? draft.dTag : undefined,
    });
  });
}

export async function removeSellerListing(
  session: SellerSession,
  eventId: string
) {
  return catalogMutation(session, async () => {
    const events = await mobileApiClient.fetchProducts(session.pubkey);
    if (
      !events.some(
        (event) =>
          event.id === eventId &&
          event.pubkey === session.pubkey &&
          event.kind === 30402
      )
    )
      throw new Error("This product is no longer available for this seller.");
    return deleteSellerListing({
      baseUrl: getApiBaseUrl(),
      session,
      eventId,
    });
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
