import {
  signEventTemplate,
  publishSignedEvent,
  cacheSignedEvent,
} from "@self-sown/nostr";
import type { SellerSession } from "@self-sown/domain";

import { getApiBaseUrl } from "./api-base-url";
import { deleteCachedEvents } from "./delete-events";

// Mirrors the web community management flow in pages/settings/community.tsx:
// communities are NIP-72 kind:34550 addressable events, signed locally,
// cached server-side, then broadcast to the seller's relays. The list read
// hits the public /api/db/fetch-communities endpoint and keeps only the
// signed-in seller's own communities.
export const COMMUNITY_KIND = 34550;

export interface SellerCommunity {
  id: string;
  d: string;
  name: string;
  description: string;
  image: string;
  createdAt: number;
}

export interface CommunityDraft {
  d: string;
  name: string;
  description: string;
  image: string;
}

async function readErrorMessage(response: Response, fallback: string) {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}

interface RawEvent {
  id?: unknown;
  kind?: unknown;
  pubkey?: unknown;
  created_at?: unknown;
  tags?: unknown;
}

function parseCommunityEvent(event: RawEvent): SellerCommunity | null {
  if (event.kind !== COMMUNITY_KIND) return null;
  if (typeof event.id !== "string" || typeof event.pubkey !== "string") {
    return null;
  }
  const tags = Array.isArray(event.tags) ? (event.tags as string[][]) : [];
  const firstTag = (name: string): string | undefined => {
    const found = tags.find((tag) => Array.isArray(tag) && tag[0] === name);
    return found && typeof found[1] === "string" ? found[1] : undefined;
  };
  const d = firstTag("d");
  if (!d) return null;
  return {
    id: event.id,
    d,
    name: firstTag("name") || d,
    description: firstTag("description") || "",
    image: firstTag("image") || "",
    createdAt: typeof event.created_at === "number" ? event.created_at : 0,
  };
}

export function newCommunityDTag(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
  } catch {
    // fall through
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Mirrors the web community-creation gate in pages/settings/community.tsx:
// creating a NEW community first requires the listing password (intentional
// anti-bot friction, returned as the hint). The server hands back the storage
// key under which the client remembers a successful validation.
export interface CommunityPasswordGateInfo {
  storageKey: string | null;
  hint: string | null;
}

export async function getCommunityPasswordGateInfo(): Promise<CommunityPasswordGateInfo> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/validate-password-auth`,
      { method: "POST", headers: { "Content-Type": "application/json" } }
    );
    if (!response.ok) return { storageKey: null, hint: null };
    const data = (await response.json()) as {
      value?: string;
      password?: string;
    };
    return {
      storageKey: typeof data.value === "string" ? data.value : null,
      hint: typeof data.password === "string" ? data.password : null,
    };
  } catch {
    return { storageKey: null, hint: null };
  }
}

export async function validateCommunityPassword(
  password: string,
  pubkey: string
): Promise<boolean> {
  const response = await fetch(`${getApiBaseUrl()}/api/validate-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: password.trim(), pubkey }),
  });
  if (!response.ok) return false;
  const data = (await response.json()) as { valid?: boolean };
  return Boolean(data.valid);
}

export async function listSellerCommunities(
  session: SellerSession
): Promise<SellerCommunity[]> {
  const response = await fetch(`${getApiBaseUrl()}/api/db/fetch-communities`);
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, "Communities could not be loaded.")
    );
  }
  const data = (await response.json()) as unknown;
  const events = Array.isArray(data) ? (data as RawEvent[]) : [];
  // Addressable events: collapse to the newest version per d-tag.
  const latest = new Map<string, SellerCommunity>();
  for (const event of events) {
    if (event.pubkey !== session.pubkey) continue;
    const parsed = parseCommunityEvent(event);
    if (!parsed) continue;
    const existing = latest.get(parsed.d);
    if (!existing || parsed.createdAt > existing.createdAt) {
      latest.set(parsed.d, parsed);
    }
  }
  return Array.from(latest.values()).sort((a, b) => b.createdAt - a.createdAt);
}

export async function saveCommunity(
  session: SellerSession,
  draft: CommunityDraft
): Promise<void> {
  const signedEvent = signEventTemplate(session, {
    kind: COMMUNITY_KIND,
    created_at: Math.floor(Date.now() / 1000),
    content: "",
    tags: [
      ["d", draft.d],
      ["name", draft.name.trim()],
      ["description", draft.description.trim()],
      ["image", draft.image.trim()],
      ["t", "selfsown"],
      ["p", session.pubkey, "", "moderator"],
    ],
  });
  await cacheSignedEvent(getApiBaseUrl(), signedEvent);
  await publishSignedEvent(session, signedEvent);
}

export async function deleteCommunity(
  session: SellerSession,
  eventId: string
): Promise<void> {
  const deleteEvent = signEventTemplate(session, {
    kind: 5,
    created_at: Math.floor(Date.now() / 1000),
    content: "Self-sown deletion request",
    tags: [
      ["e", eventId],
      ["k", String(COMMUNITY_KIND)],
    ],
  });
  await publishSignedEvent(session, deleteEvent);
  await deleteCachedEvents(session, [eventId]);
}
