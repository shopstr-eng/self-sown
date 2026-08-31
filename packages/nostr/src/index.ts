import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
  SimplePool,
  type Event,
  type EventTemplate,
} from "nostr-tools";
import CryptoJS from "crypto-js";

import {
  DEFAULT_SELLER_RELAYS,
  buildSellerListingTags,
  type NostrEventRecord,
  type SellerListingDraft,
  type SellerSession,
} from "@milk-market/domain";

export * from "./order-messages";

export const NOSTR_PACKAGE_READY = true as const;

const STRIPE_CONNECT_AUTH_KIND = 27235;
const BLOSSOM_UPLOAD_KIND = 24242;
const SIGNED_EVENT_HEADER = "x-signed-event";
const shopPublishPool = new SimplePool();
const DEFAULT_BLOSSOM_SERVER = "https://cdn.nostrcheck.me";

export type SellerActionAuthTag =
  | "stripe-connect"
  | "notification-email-read"
  | "notification-email-write"
  | "storefront-slug-write"
  | "custom-domain-write"
  | "email-sender-domain-write"
  | "storefront-import-write";

type EventTemplateWithPubkey = EventTemplate & {
  pubkey: string;
};

export class SellerNostrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SellerNostrError";
  }
}

export interface UploadedSellerListingMedia {
  url: string;
  sha256: string;
  size: number;
  mimeType: string;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

function getPrivKeyBytes(nsec: string): Uint8Array {
  const decoded = nip19.decode(nsec.trim());
  if (decoded.type !== "nsec") {
    throw new SellerNostrError("Invalid nsec input.");
  }

  return decoded.data as Uint8Array;
}

function getPublishRelays(session: SellerSession): string[] {
  const relayList =
    session.writeRelays.length > 0 ? session.writeRelays : session.relays;
  const fallbackRelays =
    relayList.length > 0 ? relayList : [...DEFAULT_SELLER_RELAYS];

  return Array.from(new Set(fallbackRelays));
}

function getPrimaryRelayHint(session: SellerSession): string {
  return getPublishRelays(session)[0] ?? "";
}

function getWebsiteOrigin(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "") || "https://milk.market";
}

function createRandomDTag(prefix: string): string {
  return `${prefix}-${Array.from(generateSecretKey(), (value) =>
    value.toString(16).padStart(2, "0")
  ).join("")}`;
}

export function createSellerListingDTag(): string {
  return createRandomDTag("listing");
}

function addPublishedAtTag(tags: string[][], publishedAt: number): string[][] {
  return [
    ...tags.filter((tag) => tag[0] !== "published_at"),
    ["published_at", String(publishedAt)],
  ];
}

function createWordArray(bytes: Uint8Array) {
  const words: number[] = [];
  for (let index = 0; index < bytes.length; index += 4) {
    words.push(
      ((bytes[index] || 0) << 24) |
        ((bytes[index + 1] || 0) << 16) |
        ((bytes[index + 2] || 0) << 8) |
        (bytes[index + 3] || 0)
    );
  }

  return CryptoJS.lib.WordArray.create(words, bytes.length);
}

function toBase64Json(value: unknown): string {
  return CryptoJS.enc.Base64.stringify(
    CryptoJS.enc.Utf8.parse(JSON.stringify(value))
  );
}

async function deleteCachedEvents(
  baseUrl: string,
  session: SellerSession,
  eventIds: string[]
): Promise<void> {
  if (eventIds.length === 0) {
    return;
  }

  const signedProof = signEventTemplate(session, {
    kind: STRIPE_CONNECT_AUTH_KIND,
    created_at: Math.floor(Date.now() / 1000),
    content: "",
    tags: [
      ["action", "delete_cached_events"],
      ["method", "POST"],
      ["path", "/api/db/delete-events"],
      ["pubkey", session.pubkey],
      ["eventIds", [...eventIds].sort().join(",")],
    ],
  });

  const response = await fetch(joinUrl(baseUrl, "/api/db/delete-events"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [SIGNED_EVENT_HEADER]: JSON.stringify(signedProof),
    },
    body: JSON.stringify({ eventIds }),
  });

  if (!response.ok) {
    throw new SellerNostrError("Failed to delete cached listing events.");
  }
}

async function publishAndCacheEvent(
  baseUrl: string,
  session: SellerSession,
  event: Event,
  cacheRequired = true
): Promise<void> {
  await publishSignedEvent(session, event);
  try {
    await cacheSignedEvent(baseUrl, event);
  } catch (error) {
    if (cacheRequired) {
      throw error;
    }
    console.warn("Published event but failed to cache it.", error);
  }
}

export function generateSellerNsecCredentials(): {
  nsec: string;
  pubkey: string;
} {
  const secretKey = generateSecretKey();
  return {
    nsec: nip19.nsecEncode(secretKey),
    pubkey: getPublicKey(secretKey),
  };
}

export function validateSellerNsec(input: string): {
  valid: boolean;
  normalized?: string;
  pubkey?: string;
  error?: string;
} {
  const normalized = input.trim();

  if (!normalized) {
    return { valid: false, error: "Enter your nsec to continue." };
  }

  try {
    const privateKey = getPrivKeyBytes(normalized);
    return {
      valid: true,
      normalized,
      pubkey: getPublicKey(privateKey),
    };
  } catch {
    return { valid: false, error: "Enter a valid nsec key." };
  }
}

export function createSellerSessionFromNsec(
  nsec: string,
  options: {
    authMethod?: SellerSession["authMethod"];
    email?: string;
    relays?: string[];
    writeRelays?: string[];
  } = {}
): SellerSession {
  const validation = validateSellerNsec(nsec);
  if (!validation.valid || !validation.normalized || !validation.pubkey) {
    throw new SellerNostrError(validation.error ?? "Invalid nsec.");
  }

  const relays =
    options.relays && options.relays.length > 0
      ? options.relays
      : [...DEFAULT_SELLER_RELAYS];
  const writeRelays =
    options.writeRelays && options.writeRelays.length > 0
      ? options.writeRelays
      : relays;

  return {
    authMethod: options.authMethod ?? "nsec",
    pubkey: validation.pubkey,
    nsec: validation.normalized,
    email: options.email,
    relays,
    writeRelays,
    createdAt: Math.floor(Date.now() / 1000),
  };
}

export function serializeSellerSession(session: SellerSession): string {
  return JSON.stringify({
    version: 1,
    ...session,
  });
}

export function deserializeSellerSession(raw: string): SellerSession | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SellerSession> & {
      version?: number;
    };
    if (
      !parsed ||
      typeof parsed.pubkey !== "string" ||
      typeof parsed.nsec !== "string" ||
      (parsed.authMethod !== "email" && parsed.authMethod !== "nsec")
    ) {
      return null;
    }

    return {
      authMethod: parsed.authMethod,
      pubkey: parsed.pubkey,
      nsec: parsed.nsec,
      email: typeof parsed.email === "string" ? parsed.email : undefined,
      relays:
        Array.isArray(parsed.relays) &&
        parsed.relays.every((item) => typeof item === "string")
          ? parsed.relays
          : [...DEFAULT_SELLER_RELAYS],
      writeRelays:
        Array.isArray(parsed.writeRelays) &&
        parsed.writeRelays.every((item) => typeof item === "string")
          ? parsed.writeRelays
          : [...DEFAULT_SELLER_RELAYS],
      createdAt:
        typeof parsed.createdAt === "number"
          ? parsed.createdAt
          : Math.floor(Date.now() / 1000),
    };
  } catch {
    return null;
  }
}

export function signEventTemplate(
  session: SellerSession,
  eventTemplate: EventTemplate
): Event {
  return finalizeEvent(eventTemplate, getPrivKeyBytes(session.nsec));
}

function getSellerActionAuthContent(action: SellerActionAuthTag): string {
  switch (action) {
    case "notification-email-read":
      return "Authorize notification email access";
    case "notification-email-write":
      return "Authorize notification email updates";
    case "storefront-slug-write":
      return "Authorize storefront slug updates";
    case "custom-domain-write":
      return "Authorize storefront custom domain updates";
    case "email-sender-domain-write":
      return "Authorize email sending domain updates";
    case "storefront-import-write":
      return "Authorize importing a stall design from a website";
    case "stripe-connect":
    default:
      return "Authorize Stripe Connect account management";
  }
}

export type SellerActionAuthBindingFieldValue =
  | string
  | number
  | null
  | undefined;

export type SellerActionAuthBinding = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path?: string;
  fields?: Record<string, SellerActionAuthBindingFieldValue>;
};

function serializeBindingFieldValue(
  value: SellerActionAuthBindingFieldValue
): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return String(value);
}

export function buildSellerActionAuthBindingTags(
  binding: SellerActionAuthBinding | undefined
): string[][] {
  if (!binding) return [];
  const tags: string[][] = [];
  if (binding.method) tags.push(["method", binding.method]);
  if (binding.path) tags.push(["path", binding.path]);
  if (binding.fields) {
    const sorted = Object.entries(binding.fields)
      .flatMap(([name, value]) => {
        const normalized = serializeBindingFieldValue(value);
        return normalized === undefined
          ? []
          : ([[name, normalized]] as Array<[string, string]>);
      })
      .sort(([a], [b]) => a.localeCompare(b));
    for (const [name, value] of sorted) {
      tags.push(["field", name, value]);
    }
  }
  return tags;
}

export function createSellerActionAuthEventTemplate(
  pubkey: string,
  action: SellerActionAuthTag,
  binding?: SellerActionAuthBinding
): EventTemplateWithPubkey {
  return {
    pubkey,
    kind: STRIPE_CONNECT_AUTH_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["action", action], ...buildSellerActionAuthBindingTags(binding)],
    content: getSellerActionAuthContent(action),
  };
}

export function createStripeConnectAuthEventTemplate(
  pubkey: string
): EventTemplateWithPubkey {
  return createSellerActionAuthEventTemplate(pubkey, "stripe-connect");
}

export function createSignedSellerActionAuthEvent(
  session: SellerSession,
  action: SellerActionAuthTag,
  binding?: SellerActionAuthBinding
): Event {
  return signEventTemplate(
    session,
    createSellerActionAuthEventTemplate(session.pubkey, action, binding)
  );
}

export function createSignedStorefrontSlugAuthEvent(
  session: SellerSession,
  method: "POST",
  slug: string
): Event;
export function createSignedStorefrontSlugAuthEvent(
  session: SellerSession,
  method: "DELETE"
): Event;
export function createSignedStorefrontSlugAuthEvent(
  session: SellerSession,
  method: "POST" | "DELETE",
  slug?: string
): Event {
  if (method === "POST" && !slug?.trim()) {
    throw new SellerNostrError(
      "A storefront slug is required to authorize registration."
    );
  }

  return createSignedSellerActionAuthEvent(session, "storefront-slug-write", {
    method,
    path: "/api/storefront/register-slug",
    fields: method === "POST" ? { slug } : undefined,
  });
}

export function createSignedStripeConnectAuthEvent(
  session: SellerSession,
  binding?: SellerActionAuthBinding
): Event {
  return createSignedSellerActionAuthEvent(session, "stripe-connect", binding);
}

export function createSellerShopProfileEventTemplate(
  session: SellerSession,
  content: string
): EventTemplateWithPubkey {
  return {
    pubkey: session.pubkey,
    created_at: Math.floor(Date.now() / 1000),
    content,
    kind: 30019,
    tags: [["d", session.pubkey]],
  };
}

export function createSellerListingEventTemplate(
  session: SellerSession,
  tags: string[][],
  createdAt = Math.floor(Date.now() / 1000)
): EventTemplateWithPubkey {
  const summary = tags.find((tag) => tag[0] === "summary")?.[1] ?? "";

  return {
    pubkey: session.pubkey,
    created_at: createdAt,
    content: summary,
    kind: 30402,
    tags: addPublishedAtTag(tags, createdAt),
  };
}

export function createSellerListingDeleteEventTemplate(
  session: SellerSession,
  eventIds: string[],
  reason = "Milk Market deletion request"
): EventTemplateWithPubkey {
  return {
    pubkey: session.pubkey,
    kind: 5,
    content: reason,
    created_at: Math.floor(Date.now() / 1000),
    tags: eventIds.map((eventId) => ["e", eventId]),
  };
}

function createSellerListingHandlerEventTemplate(params: {
  session: SellerSession;
  handlerDTag: string;
  origin: string;
}): EventTemplateWithPubkey {
  return {
    pubkey: params.session.pubkey,
    kind: 31990,
    tags: [
      ["d", params.handlerDTag],
      ["k", "30402"],
      ["web", `${params.origin}/marketplace/<bech-32>`, "npub"],
      ["web", `${params.origin}/listing/<bech-32>`, "naddr"],
    ],
    content: "",
    created_at: Math.floor(Date.now() / 1000),
  };
}

function createSellerListingRecommendationEventTemplate(params: {
  session: SellerSession;
  handlerDTag: string;
  relayHint: string;
}): EventTemplateWithPubkey {
  return {
    pubkey: params.session.pubkey,
    kind: 31989,
    tags: [
      ["d", "30402"],
      [
        "a",
        `31990:${params.session.pubkey}:${params.handlerDTag}`,
        params.relayHint,
        "web",
      ],
    ],
    content: "",
    created_at: Math.floor(Date.now() / 1000),
  };
}

export async function publishSellerListing(params: {
  baseUrl: string;
  session: SellerSession;
  draft: SellerListingDraft;
  existingEventId?: string;
  existingDTag?: string;
}): Promise<Event> {
  const isExistingListing = Boolean(
    params.existingEventId || params.existingDTag || params.draft.eventId
  );
  const dTag =
    params.existingDTag ?? params.draft.dTag ?? createSellerListingDTag();
  const createdAt = Math.max(
    Math.floor(Date.now() / 1000),
    (params.draft.sourceCreatedAt ?? 0) + 1
  );
  params.draft.dTag = dTag;
  params.draft.sourceCreatedAt = createdAt;
  const relayHint = getPrimaryRelayHint(params.session);
  const tags = buildSellerListingTags({
    draft: params.draft,
    pubkey: params.session.pubkey,
    dTag,
    relayHint,
  });
  const listingEvent = signEventTemplate(
    params.session,
    createSellerListingEventTemplate(params.session, tags, createdAt)
  );

  await publishAndCacheEvent(
    params.baseUrl,
    params.session,
    listingEvent,
    false
  );

  if (!isExistingListing) {
    const handlerEvent = signEventTemplate(
      params.session,
      createSellerListingHandlerEventTemplate({
        session: params.session,
        handlerDTag: dTag,
        origin: getWebsiteOrigin(params.baseUrl),
      })
    );
    const recommendationEvent = signEventTemplate(
      params.session,
      createSellerListingRecommendationEventTemplate({
        session: params.session,
        handlerDTag: dTag,
        relayHint,
      })
    );

    for (const event of [recommendationEvent, handlerEvent]) {
      try {
        await publishAndCacheEvent(params.baseUrl, params.session, event);
      } catch (error) {
        console.warn("Failed to publish auxiliary listing event.", error);
      }
    }
  }

  if (params.existingEventId && params.existingEventId !== listingEvent.id) {
    try {
      await deleteSellerListing({
        baseUrl: params.baseUrl,
        session: params.session,
        eventId: params.existingEventId,
      });
    } catch (error) {
      console.warn(
        "Updated listing but failed to retire its old event.",
        error
      );
    }
  }

  return listingEvent;
}

export async function deleteSellerListing(params: {
  baseUrl: string;
  session: SellerSession;
  eventId: string;
  reason?: string;
}): Promise<Event> {
  const deleteEvent = signEventTemplate(
    params.session,
    createSellerListingDeleteEventTemplate(
      params.session,
      [params.eventId],
      params.reason
    )
  );

  await publishAndCacheEvent(
    params.baseUrl,
    params.session,
    deleteEvent,
    false
  );
  await deleteCachedEvents(params.baseUrl, params.session, [params.eventId]);

  return deleteEvent;
}

export async function uploadSellerListingMedia(params: {
  baseUrl: string;
  session: SellerSession;
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
  uploadBody?: Blob;
  serverUrl?: string;
}): Promise<UploadedSellerListingMedia> {
  if (!params.mimeType.startsWith("image/")) {
    throw new SellerNostrError("Only image uploads are supported.");
  }

  const fileBytes = params.bytes;
  const uploadBytes = Uint8Array.from(fileBytes);
  const sha256 = CryptoJS.SHA256(createWordArray(fileBytes)).toString(
    CryptoJS.enc.Hex
  );
  const signedEvent = signEventTemplate(params.session, {
    kind: BLOSSOM_UPLOAD_KIND,
    content: `Upload ${params.fileName}`,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["t", "upload"],
      ["x", sha256],
      ["size", String(fileBytes.byteLength)],
      [
        "expiration",
        String(Math.floor((Date.now() + 24 * 60 * 60 * 1000) / 1000)),
      ],
    ],
  });

  await cacheSignedEvent(params.baseUrl, signedEvent);

  const normalizedServerUrl = params.serverUrl?.trim()
    ? params.serverUrl.trim()
    : DEFAULT_BLOSSOM_SERVER;
  const uploadOrigin = normalizedServerUrl.match(/^https?:\/\//i)
    ? normalizedServerUrl
    : `https://${normalizedServerUrl}`;
  const uploadUrl = new URL("/upload", uploadOrigin).toString();
  const uploadBody =
    params.uploadBody ?? new Blob([uploadBytes], { type: params.mimeType });
  const response = await fetch(uploadUrl, {
    method: "PUT",
    body: uploadBody,
    headers: {
      authorization: `Nostr ${toBase64Json(signedEvent)}`,
      "content-type": params.mimeType,
      "X-SHA-256": sha256,
    },
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "Unknown server error");
    throw new SellerNostrError(
      `Image upload failed (${response.status}): ${details}`
    );
  }

  const payload =
    (await response.json()) as Partial<UploadedSellerListingMedia> & {
      type?: string;
    };
  if (!payload.url || !payload.sha256 || typeof payload.size !== "number") {
    throw new SellerNostrError(
      "Image upload did not return a valid Blossom response."
    );
  }

  return {
    url: payload.url,
    sha256: payload.sha256,
    size: payload.size,
    mimeType:
      typeof payload.mimeType === "string"
        ? payload.mimeType
        : typeof payload.type === "string"
          ? payload.type
          : params.mimeType,
  };
}

export async function cacheSignedEvent(
  baseUrl: string,
  event: NostrEventRecord
): Promise<void> {
  const response = await fetch(joinUrl(baseUrl, "/api/db/cache-event"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(event),
  });

  if (!response.ok) {
    throw new SellerNostrError("Failed to cache the signed event.");
  }
}

export async function publishSignedEvent(
  session: SellerSession,
  event: Event
): Promise<void> {
  const relays = getPublishRelays(session);
  const results = await Promise.allSettled(
    shopPublishPool.publish(relays, event)
  );

  if (!results.some((result) => result.status === "fulfilled")) {
    throw new SellerNostrError(
      "The signed event could not be published to any relay."
    );
  }
}

export async function publishSellerShopProfile(params: {
  baseUrl: string;
  session: SellerSession;
  content: string;
}): Promise<Event> {
  const signedEvent = signEventTemplate(
    params.session,
    createSellerShopProfileEventTemplate(params.session, params.content)
  );

  await cacheSignedEvent(params.baseUrl, signedEvent);
  await publishSignedEvent(params.session, signedEvent);

  return signedEvent;
}
