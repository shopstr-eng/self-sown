import type { EventTemplate } from "nostr-tools";
import type { NostrEvent } from "@/utils/types/types";

const isContactTag = (tag: string[]): tag is [string, string, ...string[]] =>
  tag[0] === "p" &&
  typeof tag[1] === "string" &&
  /^[0-9a-fA-F]{64}$/.test(tag[1]);

export const contactPubkeys = (tags: string[][]): string[] =>
  Array.from(new Set(tags.filter(isContactTag).map((tag) => tag[1])));

export const latestContactList = (
  events: NostrEvent[]
): NostrEvent | undefined =>
  events.reduce<NostrEvent | undefined>((latest, event) => {
    if (event.kind !== 3) return latest;
    if (!latest || event.created_at > latest.created_at) return event;
    if (event.created_at === latest.created_at && event.id < latest.id) {
      return event;
    }
    return latest;
  }, undefined);

// A kind-3 event replaces the entire contact list. Keep each existing tag
// byte-for-byte (including relay and petname data) and only change this seller.
export const buildContactListUpdate = (
  currentTags: string[][],
  sellerPubkey: string,
  shouldFollow: boolean,
  currentCreatedAt = 0
): EventTemplate => {
  const tags = currentTags
    .filter((tag) => !(tag[0] === "p" && tag[1] === sellerPubkey))
    .map((tag) => [...tag]);

  if (shouldFollow) tags.push(["p", sellerPubkey]);

  return {
    kind: 3,
    created_at: Math.max(Math.floor(Date.now() / 1000), currentCreatedAt + 1),
    content: "",
    tags,
  };
};
