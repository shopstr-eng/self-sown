import { NostrEvent } from "@/utils/types/types";

export function getProductEventKey(event: NostrEvent): string {
  if (event.kind === 30402) {
    const dTag = event.tags?.find((tag: string[]) => tag[0] === "d")?.[1];
    if (dTag) return `${event.pubkey}:${dTag}`;
  }
  return event.id;
}

export function upsertProductEvent(
  events: NostrEvent[],
  event: NostrEvent
): NostrEvent[] {
  const key = getProductEventKey(event);
  const existingIndex = events.findIndex((e) => getProductEventKey(e) === key);
  if (existingIndex === -1) {
    return [...events, event];
  }
  if (event.created_at >= events[existingIndex].created_at) {
    const next = [...events];
    next[existingIndex] = event;
    return next;
  }
  return events;
}
