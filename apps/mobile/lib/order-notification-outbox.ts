import type { Event } from "nostr-tools";

export type OutboxExpectedStatus = "pending" | "confirmed" | "shipped";
export type OutboxNextStatus = "confirmed" | "shipped" | "completed";

export interface SellerOrderNotificationOutboxEntry {
  version: 1;
  sellerPubkey: string;
  buyerPubkey: string;
  orderId: string;
  expectedStatus: OutboxExpectedStatus;
  nextStatus: OutboxNextStatus;
  sourceMessageId: string;
  transitionId: string;
  queuedAt: number;
  serverPersisted: boolean;
  giftWrap: Event;
}

export interface AsyncKeyValueStorage {
  getAllKeys(): Promise<readonly string[]>;
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface SellerOrderNotificationOutbox {
  save(entry: SellerOrderNotificationOutboxEntry): Promise<void>;
  markServerPersisted(
    sellerPubkey: string,
    transitionId: string
  ): Promise<void>;
  remove(sellerPubkey: string, transitionId: string): Promise<void>;
  list(sellerPubkey: string): Promise<SellerOrderNotificationOutboxEntry[]>;
}

interface CreateOutboxOptions {
  storage: AsyncKeyValueStorage;
  verifyEvent(event: Event): boolean;
}

const PREFIX = "milk-market:seller-order-outbox:v1:";
const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_128 = /^[0-9a-f]{128}$/;
const ORDER_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_PENDING_PER_SELLER = 100;
const EXPECTED_BY_NEXT = {
  confirmed: "pending",
  shipped: "confirmed",
  completed: "shipped",
} as const;

function keyFor(sellerPubkey: string, transitionId: string): string {
  return `${PREFIX}${sellerPubkey}:${transitionId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isGiftWrap(value: unknown, buyerPubkey: string): value is Event {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    HEX_64.test(value.id) &&
    typeof value.pubkey === "string" &&
    HEX_64.test(value.pubkey) &&
    typeof value.created_at === "number" &&
    Number.isSafeInteger(value.created_at) &&
    value.created_at >= 0 &&
    value.kind === 1059 &&
    Array.isArray(value.tags) &&
    value.tags.length <= 128 &&
    value.tags.every(
      (tag) =>
        Array.isArray(tag) &&
        tag.length > 0 &&
        tag.length <= 8 &&
        tag.every((part) => typeof part === "string" && part.length <= 8192)
    ) &&
    value.tags.some((tag) => tag[0] === "p" && tag[1] === buyerPubkey) &&
    typeof value.content === "string" &&
    value.content.length > 0 &&
    value.content.length <= 262_144 &&
    typeof value.sig === "string" &&
    HEX_128.test(value.sig)
  );
}

function parseEntry(
  value: unknown,
  sellerPubkey: string,
  verifyEvent: (event: Event) => boolean
): SellerOrderNotificationOutboxEntry | null {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.sellerPubkey !== sellerPubkey ||
    !HEX_64.test(sellerPubkey) ||
    typeof value.buyerPubkey !== "string" ||
    !HEX_64.test(value.buyerPubkey) ||
    typeof value.orderId !== "string" ||
    !ORDER_ID.test(value.orderId) ||
    (value.expectedStatus !== "pending" &&
      value.expectedStatus !== "confirmed" &&
      value.expectedStatus !== "shipped") ||
    (value.nextStatus !== "confirmed" &&
      value.nextStatus !== "shipped" &&
      value.nextStatus !== "completed") ||
    EXPECTED_BY_NEXT[value.nextStatus] !== value.expectedStatus ||
    typeof value.sourceMessageId !== "string" ||
    !HEX_64.test(value.sourceMessageId) ||
    typeof value.transitionId !== "string" ||
    !HEX_64.test(value.transitionId) ||
    typeof value.queuedAt !== "number" ||
    !Number.isSafeInteger(value.queuedAt) ||
    value.queuedAt <= 0 ||
    typeof value.serverPersisted !== "boolean" ||
    !isGiftWrap(value.giftWrap, value.buyerPubkey) ||
    value.giftWrap.id !== value.transitionId
  ) {
    return null;
  }

  try {
    if (!verifyEvent(value.giftWrap)) {
      return null;
    }
  } catch {
    return null;
  }

  return value as unknown as SellerOrderNotificationOutboxEntry;
}

export function createSellerOrderNotificationOutbox({
  storage,
  verifyEvent,
}: CreateOutboxOptions): SellerOrderNotificationOutbox {
  async function read(
    sellerPubkey: string,
    transitionId: string
  ): Promise<SellerOrderNotificationOutboxEntry | null> {
    const key = keyFor(sellerPubkey, transitionId);
    const serialized = await storage.getItem(key);
    if (!serialized) return null;

    let value: unknown;
    try {
      value = JSON.parse(serialized) as unknown;
    } catch {
      await storage.removeItem(key);
      return null;
    }
    const entry = parseEntry(value, sellerPubkey, verifyEvent);
    if (!entry) {
      await storage.removeItem(key);
    }
    return entry;
  }

  return {
    async save(entry) {
      const validated = parseEntry(entry, entry.sellerPubkey, verifyEvent);
      if (!validated) {
        throw new Error("Invalid seller order notification outbox entry");
      }

      const existingKeys = await storage.getAllKeys();
      const sellerPrefix = `${PREFIX}${entry.sellerPubkey}:`;
      if (
        !existingKeys.includes(
          keyFor(entry.sellerPubkey, entry.transitionId)
        ) &&
        existingKeys.filter((key) => key.startsWith(sellerPrefix)).length >=
          MAX_PENDING_PER_SELLER
      ) {
        throw new Error("Seller order notification outbox is full");
      }
      const existing = await read(entry.sellerPubkey, entry.transitionId);
      await storage.setItem(
        keyFor(entry.sellerPubkey, entry.transitionId),
        JSON.stringify(
          existing
            ? {
                ...validated,
                queuedAt: existing.queuedAt,
                serverPersisted:
                  existing.serverPersisted || validated.serverPersisted,
              }
            : validated
        )
      );
    },

    async markServerPersisted(sellerPubkey, transitionId) {
      const entry = await read(sellerPubkey, transitionId);
      if (!entry) {
        throw new Error("Pending seller order notification was not found");
      }
      await storage.setItem(
        keyFor(sellerPubkey, transitionId),
        JSON.stringify({ ...entry, serverPersisted: true })
      );
    },

    async remove(sellerPubkey, transitionId) {
      await storage.removeItem(keyFor(sellerPubkey, transitionId));
    },

    async list(sellerPubkey) {
      if (!HEX_64.test(sellerPubkey)) return [];
      const sellerPrefix = `${PREFIX}${sellerPubkey}:`;
      const keys = (await storage.getAllKeys())
        .filter((key) => key.startsWith(sellerPrefix))
        .slice(0, MAX_PENDING_PER_SELLER);
      const entries = await Promise.all(
        keys.map((key) => read(sellerPubkey, key.slice(sellerPrefix.length)))
      );
      return entries
        .filter(
          (entry): entry is SellerOrderNotificationOutboxEntry => entry !== null
        )
        .sort((a, b) => a.queuedAt - b.queuedAt);
    },
  };
}
