import { signEventTemplate } from "@self-sown/nostr";
import type { SellerSession } from "@self-sown/domain";

import { getApiBaseUrl } from "./api-base-url";

// Mirrors the web deleteCachedEvents flow (utils/nostr/nostr-helper-functions.ts
// deleteEvent -> deleteEventsFromDatabase) against pages/api/db/delete-events.ts:
// kind-27235 proof with action delete_cached_events and the sorted, joined
// eventIds field, sent in the x-signed-event header.
const SIGNED_EVENT_HEADER = "x-signed-event";
const DELETE_EVENTS_PATH = "/api/db/delete-events";

export async function deleteCachedEvents(
  session: SellerSession,
  eventIds: string[]
): Promise<void> {
  if (eventIds.length === 0) return;

  const signedProof = signEventTemplate(session, {
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    content: "",
    tags: [
      ["action", "delete_cached_events"],
      ["method", "POST"],
      ["path", DELETE_EVENTS_PATH],
      ["pubkey", session.pubkey],
      ["eventIds", [...eventIds].sort().join(",")],
    ],
  });

  const response = await fetch(`${getApiBaseUrl()}${DELETE_EVENTS_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [SIGNED_EVENT_HEADER]: JSON.stringify(signedProof),
    },
    body: JSON.stringify({ eventIds }),
  });
  if (!response.ok) {
    throw new Error("The cached events could not be deleted.");
  }
}
