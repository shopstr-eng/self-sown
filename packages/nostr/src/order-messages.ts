import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
  nip19,
  nip44,
  SimplePool,
  verifyEvent,
  type Event,
} from "nostr-tools";

import {
  DEFAULT_SELLER_RELAYS,
  SELLER_ORDER_SUBJECTS,
  validateSellerShippingUpdate,
  type SellerOrderEvent,
  type SellerSession,
  type SellerShippingUpdate,
} from "@milk-market/domain";
import CryptoJS from "crypto-js";

const SELLER_ORDER_DECRYPT_CONCURRENCY = 8;

export interface CachedSellerGiftWrap extends Event {
  kind: 1059;
  is_read: boolean;
}

export type SellerOrderUnwrapRejectionReason =
  | "invalid-session"
  | "invalid-envelope"
  | "wrong-recipient"
  | "invalid-seal"
  | "invalid-rumor"
  | "unsupported-subject";

export type SellerOrderUnwrapResult =
  | { ok: true; event: SellerOrderEvent }
  | { ok: false; reason: SellerOrderUnwrapRejectionReason };

export interface UnwrapSellerOrderGiftWrapInput {
  session: SellerSession;
  giftWrap: CachedSellerGiftWrap;
}

export interface UnwrapSellerOrderGiftWrapsInput {
  session: SellerSession;
  giftWraps: CachedSellerGiftWrap[];
}

export interface SellerOrderGiftWrapBatchResult {
  events: SellerOrderEvent[];
  rejected: Array<{
    wrappedEventId: string;
    reason: SellerOrderUnwrapRejectionReason;
  }>;
}

const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_128 = /^[0-9a-f]{128}$/;
const MAX_TAGS = 128;
const MAX_TAG_PARTS = 8;
const MAX_TAG_PART_LENGTH = 8192;
const MAX_ENCRYPTED_CONTENT_LENGTH = 262_144;
const MAX_RUMOR_CONTENT_LENGTH = 16_384;
const MAX_BATCH_SIZE = 1000;
const ORDER_SUBJECT_SET = new Set<string>(SELLER_ORDER_SUBJECTS);
const ORDER_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_NIP98_BODY_LENGTH = 262_144;
const sellerOrderPublishPool = new SimplePool();

const STATUS_MESSAGE_DETAILS: Record<
  "confirmed" | "shipped" | "completed",
  {
    subject: "order-receipt" | "shipping-info" | "order-completed";
    content: string;
  }
> = {
  confirmed: {
    subject: "order-receipt",
    content: "Your order has been confirmed.",
  },
  shipped: {
    subject: "shipping-info",
    content: "Your order has been shipped.",
  },
  completed: {
    subject: "order-completed",
    content: "Your order has been completed.",
  },
};

export class SellerOrderNostrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SellerOrderNostrError";
  }
}

export interface CreateNip98AuthorizationHeaderInput {
  session: SellerSession;
  url: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: string;
}

export interface CreateSellerOrderStatusGiftWrapInput {
  session: SellerSession;
  buyerPubkey: string;
  orderId: string;
  productAddress: string;
  status: "confirmed" | "shipped" | "completed";
  shipping?: SellerShippingUpdate;
}

export interface PublishSellerOrderStatusGiftWrapInput {
  baseUrl: string;
  session: SellerSession;
  giftWrap: Event;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringTags(value: unknown): value is string[][] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_TAGS &&
    value.every(
      (tag) =>
        Array.isArray(tag) &&
        tag.length > 0 &&
        tag.length <= MAX_TAG_PARTS &&
        tag.every(
          (part) =>
            typeof part === "string" && part.length <= MAX_TAG_PART_LENGTH
        )
    )
  );
}

function hasRecipient(tags: string[][], pubkey: string): boolean {
  return tags.some((tag) => tag[0] === "p" && tag[1] === pubkey);
}

function getTagValue(tags: string[][], key: string): string | undefined {
  return tags.find((tag) => tag[0] === key)?.[1];
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function getValidatedSessionPrivateKey(
  session: SellerSession
): Uint8Array | null {
  if (!HEX_64.test(session.pubkey)) {
    return null;
  }

  try {
    const decoded = nip19.decode(session.nsec.trim());
    if (decoded.type !== "nsec") {
      return null;
    }
    const privateKey = decoded.data as Uint8Array;
    return getPublicKey(privateKey) === session.pubkey ? privateKey : null;
  } catch {
    return null;
  }
}

function requireSessionPrivateKey(session: SellerSession): Uint8Array {
  const privateKey = getValidatedSessionPrivateKey(session);
  if (!privateKey) {
    throw new SellerOrderNostrError(
      "Cannot use seller order cryptography with an invalid session."
    );
  }
  return privateKey;
}

function getRandomizedTimestamp(): number {
  const entropy = generateSecretKey();
  const jitterSource =
    ((entropy[0] ?? 0) << 16) | ((entropy[1] ?? 0) << 8) | (entropy[2] ?? 0);
  const jitterSeconds = jitterSource % (2 * 24 * 60 * 60 + 1);
  return Math.max(0, Math.floor(Date.now() / 1000) - jitterSeconds);
}

function encodeBase64Utf8(value: string): string {
  return CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse(value));
}

function sha256Hex(value: string): string {
  return CryptoJS.SHA256(value).toString(CryptoJS.enc.Hex);
}

function isSellerProductAddress(
  productAddress: string,
  sellerPubkey: string
): boolean {
  if (productAddress.length > 400) {
    return false;
  }
  const firstColon = productAddress.indexOf(":");
  const secondColon = productAddress.indexOf(":", firstColon + 1);
  if (firstColon === -1 || secondColon === -1) {
    return false;
  }
  const kind = productAddress.slice(0, firstColon);
  const merchantPubkey = productAddress.slice(firstColon + 1, secondColon);
  const dTag = productAddress.slice(secondColon + 1);
  return (
    kind === "30402" &&
    merchantPubkey === sellerPubkey &&
    HEX_64.test(merchantPubkey) &&
    dTag.length > 0 &&
    dTag.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(dTag)
  );
}

function getPublishRelays(session: SellerSession): string[] {
  const configured =
    session.writeRelays.length > 0 ? session.writeRelays : session.relays;
  const candidates =
    configured.length > 0 ? configured : [...DEFAULT_SELLER_RELAYS];
  const filtered = Array.from(
    new Set(
      candidates
        .map((relay) => relay.trim())
        .filter(
          (relay) =>
            relay.length <= 2048 && /^(wss|ws):\/\/[^\s]+$/i.test(relay)
        )
    )
  ).slice(0, 20);
  return filtered.length > 0 ? filtered : [...DEFAULT_SELLER_RELAYS];
}

function normalizeHttpBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  if (!normalized || normalized.length > 2048) {
    throw new SellerOrderNostrError(
      "Cannot publish the seller order status update."
    );
  }
  try {
    const parsed = new URL(normalized);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username ||
      parsed.password ||
      parsed.hash
    ) {
      throw new Error("invalid URL");
    }
  } catch {
    throw new SellerOrderNostrError(
      "Cannot publish the seller order status update."
    );
  }
  return normalized;
}

function isSignedEventRecord(value: unknown): value is Event {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    HEX_64.test(value.id) &&
    typeof value.pubkey === "string" &&
    HEX_64.test(value.pubkey) &&
    typeof value.created_at === "number" &&
    Number.isSafeInteger(value.created_at) &&
    value.created_at >= 0 &&
    typeof value.kind === "number" &&
    Number.isSafeInteger(value.kind) &&
    isStringTags(value.tags) &&
    typeof value.content === "string" &&
    value.content.length <= MAX_ENCRYPTED_CONTENT_LENGTH &&
    typeof value.sig === "string" &&
    HEX_128.test(value.sig)
  );
}

function isValidGiftWrap(value: CachedSellerGiftWrap): boolean {
  return (
    isSignedEventRecord(value) &&
    value.kind === 1059 &&
    typeof value.is_read === "boolean" &&
    verifyEvent(value)
  );
}

function parseRumor(value: unknown): SellerOrderEvent | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !HEX_64.test(value.id) ||
    typeof value.pubkey !== "string" ||
    !HEX_64.test(value.pubkey) ||
    typeof value.created_at !== "number" ||
    !Number.isSafeInteger(value.created_at) ||
    value.created_at < 0 ||
    value.kind !== 14 ||
    !isStringTags(value.tags) ||
    typeof value.content !== "string" ||
    value.content.length > MAX_RUMOR_CONTENT_LENGTH
  ) {
    return null;
  }

  const rumor: SellerOrderEvent = {
    id: value.id,
    pubkey: value.pubkey,
    created_at: value.created_at,
    kind: 14,
    tags: value.tags,
    content: value.content,
  };

  try {
    return getEventHash(rumor as Event) === rumor.id ? rumor : null;
  } catch {
    return null;
  }
}

export function createSellerMessagesListProof(session: SellerSession): Event {
  const privateKey = requireSessionPrivateKey(session);
  return finalizeEvent(
    {
      kind: 27_235,
      created_at: Math.floor(Date.now() / 1000),
      content: "",
      tags: [
        ["action", "list_messages"],
        ["method", "GET"],
        ["path", "/api/db/fetch-messages"],
        ["pubkey", session.pubkey],
      ],
    },
    privateKey
  );
}

export function createNip98AuthorizationHeader(
  input: CreateNip98AuthorizationHeaderInput
): string {
  const privateKey = requireSessionPrivateKey(input.session);
  const method = input.method.toUpperCase();
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(input.url);
  } catch {
    throw new SellerOrderNostrError(
      "Cannot create authorization for an invalid request URL."
    );
  }
  if (
    input.url.length > 2048 ||
    (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.hash ||
    (input.body !== undefined && input.body.length > MAX_NIP98_BODY_LENGTH)
  ) {
    throw new SellerOrderNostrError(
      "Cannot create authorization for an invalid request."
    );
  }

  const tags: string[][] = [
    ["u", input.url],
    ["method", method],
  ];
  if (input.body !== undefined) {
    tags.push(["payload", sha256Hex(input.body)]);
  }
  const event = finalizeEvent(
    {
      kind: 27_235,
      created_at: Math.floor(Date.now() / 1000),
      content: "",
      tags,
    },
    privateKey
  );
  return `Nostr ${encodeBase64Utf8(JSON.stringify(event))}`;
}

export function createSellerOrderStatusGiftWrap(
  input: CreateSellerOrderStatusGiftWrapInput
): Event {
  const sellerPrivateKey = requireSessionPrivateKey(input.session);
  const shippingValidation = validateSellerShippingUpdate(input.shipping ?? {});
  if (
    !HEX_64.test(input.buyerPubkey) ||
    input.buyerPubkey === input.session.pubkey ||
    !ORDER_ID.test(input.orderId) ||
    !isSellerProductAddress(input.productAddress, input.session.pubkey) ||
    Object.keys(shippingValidation.errors).length > 0
  ) {
    throw new SellerOrderNostrError(
      "Cannot create the seller order status update."
    );
  }

  const messageDetails = STATUS_MESSAGE_DETAILS[input.status];
  if (!messageDetails) {
    throw new SellerOrderNostrError(
      "Cannot create the seller order status update."
    );
  }
  const shipping = shippingValidation.value;
  const rumorTemplate = {
    pubkey: input.session.pubkey,
    kind: 14,
    created_at: Math.floor(Date.now() / 1000),
    content: messageDetails.content,
    tags: [
      ["p", input.buyerPubkey],
      ["subject", messageDetails.subject],
      ["order", input.orderId],
      ["item", input.productAddress, "1"],
      ["status", input.status],
      ...(shipping.carrier ? [["carrier", shipping.carrier]] : []),
      ...(shipping.tracking ? [["tracking", shipping.tracking]] : []),
      ...(shipping.eta !== undefined ? [["eta", String(shipping.eta)]] : []),
    ],
  };
  const rumor = {
    ...rumorTemplate,
    id: getEventHash(rumorTemplate as Event),
  };

  const sellerConversationKey = nip44.getConversationKey(
    sellerPrivateKey,
    input.buyerPubkey
  );
  const seal = finalizeEvent(
    {
      kind: 13,
      created_at: getRandomizedTimestamp(),
      tags: [],
      content: nip44.encrypt(JSON.stringify(rumor), sellerConversationKey),
    },
    sellerPrivateKey
  );

  const outerPrivateKey = generateSecretKey();
  const outerConversationKey = nip44.getConversationKey(
    outerPrivateKey,
    input.buyerPubkey
  );
  return finalizeEvent(
    {
      kind: 1059,
      created_at: getRandomizedTimestamp(),
      tags: [["p", input.buyerPubkey]],
      content: nip44.encrypt(JSON.stringify(seal), outerConversationKey),
    },
    outerPrivateKey
  );
}

export async function publishSellerOrderStatusGiftWrap(
  input: PublishSellerOrderStatusGiftWrapInput
): Promise<void> {
  requireSessionPrivateKey(input.session);
  const baseUrl = normalizeHttpBaseUrl(input.baseUrl);
  let eventIsValid = false;
  try {
    eventIsValid =
      input.giftWrap.kind === 1059 &&
      verifyEvent(input.giftWrap) &&
      input.giftWrap.tags.some(
        (tag) =>
          tag[0] === "p" && typeof tag[1] === "string" && HEX_64.test(tag[1])
      );
  } catch {
    eventIsValid = false;
  }
  if (!eventIsValid) {
    throw new SellerOrderNostrError(
      "Cannot publish the seller order status update."
    );
  }

  const cacheResponse = await fetch(`${baseUrl}/api/db/cache-event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input.giftWrap),
  });
  if (!cacheResponse.ok) {
    throw new SellerOrderNostrError(
      "The seller order status update could not be cached."
    );
  }

  const publishResults = await Promise.allSettled(
    sellerOrderPublishPool.publish(
      getPublishRelays(input.session),
      input.giftWrap
    )
  );
  if (!publishResults.some((result) => result.status === "fulfilled")) {
    throw new SellerOrderNostrError(
      "The seller order status update could not be published to any relay."
    );
  }
}

export async function unwrapSellerOrderGiftWrap(
  input: UnwrapSellerOrderGiftWrapInput
): Promise<SellerOrderUnwrapResult> {
  const privateKey = getValidatedSessionPrivateKey(input.session);
  if (!privateKey) {
    return { ok: false, reason: "invalid-session" };
  }

  let giftWrapIsValid = false;
  try {
    giftWrapIsValid = isValidGiftWrap(input.giftWrap);
  } catch {
    giftWrapIsValid = false;
  }
  if (!giftWrapIsValid) {
    return { ok: false, reason: "invalid-envelope" };
  }
  if (!hasRecipient(input.giftWrap.tags, input.session.pubkey)) {
    return { ok: false, reason: "wrong-recipient" };
  }

  let sealRecord: Record<string, unknown> | null = null;
  try {
    const outerConversationKey = nip44.getConversationKey(
      privateKey,
      input.giftWrap.pubkey
    );
    const sealPlaintext = nip44.decrypt(
      input.giftWrap.content,
      outerConversationKey
    );
    sealRecord = parseJsonRecord(sealPlaintext);
  } catch {
    return { ok: false, reason: "invalid-envelope" };
  }

  let sealIsValid = false;
  try {
    sealIsValid =
      isSignedEventRecord(sealRecord) &&
      sealRecord.kind === 13 &&
      verifyEvent(sealRecord);
  } catch {
    sealIsValid = false;
  }
  if (!sealIsValid || !isSignedEventRecord(sealRecord)) {
    return { ok: false, reason: "invalid-seal" };
  }

  let rumor: SellerOrderEvent | null = null;
  try {
    const sealConversationKey = nip44.getConversationKey(
      privateKey,
      sealRecord.pubkey
    );
    const rumorPlaintext = nip44.decrypt(
      sealRecord.content,
      sealConversationKey
    );
    rumor = parseRumor(parseJsonRecord(rumorPlaintext));
  } catch {
    return { ok: false, reason: "invalid-rumor" };
  }

  if (!rumor || rumor.pubkey !== sealRecord.pubkey) {
    return { ok: false, reason: "invalid-rumor" };
  }
  if (!hasRecipient(rumor.tags, input.session.pubkey)) {
    return { ok: false, reason: "wrong-recipient" };
  }

  const subject = getTagValue(rumor.tags, "subject");
  if (!subject || !ORDER_SUBJECT_SET.has(subject)) {
    return { ok: false, reason: "unsupported-subject" };
  }

  return {
    ok: true,
    event: {
      ...rumor,
      read: input.giftWrap.is_read,
      wrappedEventId: input.giftWrap.id,
    },
  };
}

export async function unwrapSellerOrderGiftWraps(
  input: UnwrapSellerOrderGiftWrapsInput
): Promise<SellerOrderGiftWrapBatchResult> {
  const giftWraps = input.giftWraps.slice(0, MAX_BATCH_SIZE);
  const outcomes = new Array<SellerOrderUnwrapResult>(giftWraps.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < giftWraps.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const giftWrap = giftWraps[currentIndex];
      if (!giftWrap) {
        continue;
      }
      outcomes[currentIndex] = await unwrapSellerOrderGiftWrap({
        session: input.session,
        giftWrap,
      });
    }
  }

  const workerCount = Math.min(
    SELLER_ORDER_DECRYPT_CONCURRENCY,
    giftWraps.length
  );
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const events: SellerOrderEvent[] = [];
  const rejected: SellerOrderGiftWrapBatchResult["rejected"] = [];
  for (let index = 0; index < outcomes.length; index += 1) {
    const outcome = outcomes[index];
    const giftWrap = giftWraps[index];
    if (!outcome || !giftWrap) {
      continue;
    }
    if (outcome.ok) {
      events.push(outcome.event);
    } else {
      rejected.push({
        wrappedEventId: HEX_64.test(giftWrap.id) ? giftWrap.id : "",
        reason: outcome.reason,
      });
    }
  }

  return { events, rejected };
}
