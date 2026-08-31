/** @jest-environment node */

import type { Event } from "nostr-tools";

import {
  createSellerOrderNotificationOutbox,
  type AsyncKeyValueStorage,
  type SellerOrderNotificationOutboxEntry,
} from "@/apps/mobile/lib/order-notification-outbox";

const sellerPubkey = "a".repeat(64);
const buyerPubkey = "b".repeat(64);
const giftWrap = {
  id: "2".repeat(64),
  pubkey: "3".repeat(64),
  created_at: 1_750_000_000,
  kind: 1059,
  tags: [["p", buyerPubkey]],
  content: "encrypted",
  sig: "4".repeat(128),
} as Event;

function createMemoryStorage(): AsyncKeyValueStorage & {
  values: Map<string, string>;
} {
  const values = new Map<string, string>();
  return {
    values,
    getAllKeys: async () => Array.from(values.keys()),
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value);
    },
    removeItem: async (key) => {
      values.delete(key);
    },
  };
}

function makeEntry(
  overrides: Partial<SellerOrderNotificationOutboxEntry> = {}
): SellerOrderNotificationOutboxEntry {
  return {
    version: 1,
    sellerPubkey,
    buyerPubkey,
    orderId: "order-123",
    expectedStatus: "pending",
    nextStatus: "confirmed",
    sourceMessageId: "1".repeat(64),
    transitionId: giftWrap.id,
    queuedAt: 1_750_000_000_000,
    serverPersisted: false,
    giftWrap,
    ...overrides,
  };
}

describe("seller order notification outbox", () => {
  it("restores the exact signed gift wrap after a fresh runtime instance", async () => {
    const storage = createMemoryStorage();
    const firstRuntime = createSellerOrderNotificationOutbox({
      storage,
      verifyEvent: () => true,
    });
    await firstRuntime.save(makeEntry());

    const restartedRuntime = createSellerOrderNotificationOutbox({
      storage,
      verifyEvent: () => true,
    });

    await expect(restartedRuntime.list(sellerPubkey)).resolves.toEqual([
      makeEntry(),
    ]);
  });

  it("isolates pending notifications by seller account", async () => {
    const storage = createMemoryStorage();
    const outbox = createSellerOrderNotificationOutbox({
      storage,
      verifyEvent: () => true,
    });
    await outbox.save(makeEntry());

    await expect(outbox.list("c".repeat(64))).resolves.toEqual([]);
  });

  it("replays by durable enqueue order rather than randomized gift-wrap time", async () => {
    const storage = createMemoryStorage();
    const outbox = createSellerOrderNotificationOutbox({
      storage,
      verifyEvent: () => true,
    });
    const laterWrap = {
      ...giftWrap,
      id: "5".repeat(64),
      created_at: giftWrap.created_at - 1000,
    };
    await outbox.save(makeEntry());
    await outbox.save(
      makeEntry({
        transitionId: laterWrap.id,
        queuedAt: 1_750_000_000_100,
        giftWrap: laterWrap,
      })
    );

    await expect(outbox.list(sellerPubkey)).resolves.toEqual([
      makeEntry(),
      makeEntry({
        transitionId: laterWrap.id,
        queuedAt: 1_750_000_000_100,
        giftWrap: laterWrap,
      }),
    ]);
  });

  it("removes tampered persisted entries instead of replaying them", async () => {
    const storage = createMemoryStorage();
    const outbox = createSellerOrderNotificationOutbox({
      storage,
      verifyEvent: () => true,
    });
    await outbox.save(makeEntry());
    const [key] = await storage.getAllKeys();
    if (!key) throw new Error("Expected a persisted outbox key");
    await storage.setItem(
      key,
      JSON.stringify(makeEntry({ buyerPubkey: "attacker" }))
    );

    await expect(outbox.list(sellerPubkey)).resolves.toEqual([]);
    expect(storage.values.size).toBe(0);
  });
});
