/** @jest-environment node */

import type { Event } from "nostr-tools";

import {
  createSellerOrderActionCoordinator,
  retryPendingSellerOrderNotifications,
  type SellerOrderActionDependencies,
} from "@/apps/mobile/lib/order-actions";
import {
  createSellerOrderNotificationOutbox,
  type AsyncKeyValueStorage,
  type SellerOrderNotificationOutbox,
} from "@/apps/mobile/lib/order-notification-outbox";
import type { SellerOrder, SellerSession } from "@milk-market/domain";

const sellerPubkey = "a".repeat(64);
const buyerPubkey = "b".repeat(64);
const wrapId = "1".repeat(64);

const session: SellerSession = {
  authMethod: "nsec",
  pubkey: sellerPubkey,
  nsec: "nsec-test-only",
  relays: ["wss://relay.example"],
  writeRelays: ["wss://relay.example"],
  createdAt: 1_750_000_000,
};

const statusGiftWrap = {
  id: "2".repeat(64),
  pubkey: "3".repeat(64),
  created_at: 1_750_000_000,
  kind: 1059,
  tags: [["p", buyerPubkey]],
  content: "encrypted",
  sig: "4".repeat(128),
} as Event;

function makeOrder(overrides: Partial<SellerOrder> = {}): SellerOrder {
  return {
    orderId: "order-123",
    subject: "order-info",
    sellerPubkey,
    buyerPubkey,
    isGuest: false,
    productAddress: `30402:${sellerPubkey}:fresh-milk`,
    productTitle: "Fresh Milk",
    quantity: 2,
    amount: 24.5,
    currency: "USD",
    status: "pending",
    createdAt: 1_750_000_000,
    updatedAt: 1_750_000_000,
    unread: true,
    sourceEventIds: ["5".repeat(64)],
    wrappedEventIds: [wrapId],
    history: [
      {
        sourceEventId: "5".repeat(64),
        subject: "order-info",
        status: "pending",
        createdAt: 1_750_000_000,
      },
    ],
    ...overrides,
  };
}

function makeDependencies(
  overrides: Partial<SellerOrderActionDependencies> = {}
): SellerOrderActionDependencies {
  return {
    apiBaseUrl: "http://127.0.0.1:5000",
    createStatusGiftWrap: jest.fn(() => statusGiftWrap),
    createAuthorizationHeader: jest.fn(() => "Nostr authorization"),
    persistStatus: jest.fn(async () => ({ persisted: true })),
    publishStatusGiftWrap: jest.fn(async () => undefined),
    outbox: {
      save: jest.fn(async () => undefined),
      markServerPersisted: jest.fn(async () => undefined),
      remove: jest.fn(async () => undefined),
      list: jest.fn(async () => []),
    },
    ...overrides,
  };
}

function createMemoryOutbox(): SellerOrderNotificationOutbox {
  const values = new Map<string, string>();
  const storage: AsyncKeyValueStorage = {
    getAllKeys: async () => Array.from(values.keys()),
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value);
    },
    removeItem: async (key) => {
      values.delete(key);
    },
  };
  return createSellerOrderNotificationOutbox({
    storage,
    verifyEvent: () => true,
  });
}

describe("seller order action coordinator", () => {
  it("rejects an illegal transition before performing any side effect", async () => {
    const dependencies = makeDependencies();
    const coordinator = createSellerOrderActionCoordinator(dependencies);

    await expect(
      coordinator.execute({
        session,
        order: makeOrder(),
        nextStatus: "shipped",
      })
    ).resolves.toMatchObject({
      ok: false,
      code: "INVALID_TRANSITION",
      progress: {
        serverPersisted: false,
        buyerNotificationRequired: true,
        buyerNotified: false,
      },
    });

    expect(dependencies.createStatusGiftWrap).not.toHaveBeenCalled();
    expect(dependencies.createAuthorizationHeader).not.toHaveBeenCalled();
    expect(dependencies.persistStatus).not.toHaveBeenCalled();
    expect(dependencies.publishStatusGiftWrap).not.toHaveBeenCalled();
  });

  it("rejects an order without a trusted source wrap before side effects", async () => {
    const dependencies = makeDependencies();
    const coordinator = createSellerOrderActionCoordinator(dependencies);

    await expect(
      coordinator.execute({
        session,
        order: makeOrder({ wrappedEventIds: [] }),
        nextStatus: "confirmed",
      })
    ).resolves.toMatchObject({ ok: false, code: "INVALID_TRANSITION" });
    expect(dependencies.createStatusGiftWrap).not.toHaveBeenCalled();
    expect(dependencies.persistStatus).not.toHaveBeenCalled();
  });

  it("persists the status before publishing the encrypted buyer update", async () => {
    const callOrder: string[] = [];
    const dependencies = makeDependencies({
      outbox: {
        save: jest.fn(async () => {
          callOrder.push("outbox");
        }),
        markServerPersisted: jest.fn(async () => undefined),
        remove: jest.fn(async () => undefined),
        list: jest.fn(async () => []),
      },
      persistStatus: jest.fn(async () => {
        callOrder.push("server");
        return { persisted: true };
      }),
      publishStatusGiftWrap: jest.fn(async () => {
        callOrder.push("buyer");
      }),
    });
    const coordinator = createSellerOrderActionCoordinator(dependencies);

    const result = await coordinator.execute({
      session,
      order: makeOrder(),
      nextStatus: "confirmed",
    });

    expect(result).toMatchObject({
      ok: true,
      progress: {
        orderId: "order-123",
        nextStatus: "confirmed",
        sourceMessageId: wrapId,
        serverPersisted: true,
        buyerNotificationRequired: true,
        buyerNotified: true,
        giftWrap: statusGiftWrap,
      },
    });
    expect(callOrder).toEqual(["outbox", "server", "buyer"]);
    expect(dependencies.createAuthorizationHeader).toHaveBeenCalledWith({
      session,
      url: "http://127.0.0.1:5000/api/db/update-order-status",
      method: "POST",
      body: JSON.stringify({
        orderId: "order-123",
        sellerPubkey,
        buyerPubkey,
        expectedStatus: "pending",
        status: "confirmed",
        messageId: wrapId,
        transitionId: statusGiftWrap.id,
      }),
    });
    expect(dependencies.persistStatus).toHaveBeenCalledWith({
      orderId: "order-123",
      sellerPubkey,
      buyerPubkey,
      expectedStatus: "pending",
      status: "confirmed",
      messageId: wrapId,
      transitionId: statusGiftWrap.id,
      authorizationHeader: "Nostr authorization",
    });
  });

  it("persists guest orders without constructing or publishing a buyer event", async () => {
    const dependencies = makeDependencies();
    const coordinator = createSellerOrderActionCoordinator(dependencies);

    await expect(
      coordinator.execute({
        session,
        order: makeOrder({ isGuest: true }),
        nextStatus: "confirmed",
      })
    ).resolves.toMatchObject({
      ok: true,
      progress: {
        serverPersisted: true,
        buyerNotificationRequired: false,
        buyerNotified: false,
      },
    });

    expect(dependencies.createStatusGiftWrap).not.toHaveBeenCalled();
    expect(dependencies.publishStatusGiftWrap).not.toHaveBeenCalled();
  });

  it("retries only buyer publication after server persistence succeeds", async () => {
    const publishStatusGiftWrap = jest
      .fn()
      .mockRejectedValueOnce(new Error("relay failure"))
      .mockResolvedValueOnce(undefined);
    const dependencies = makeDependencies({ publishStatusGiftWrap });
    const coordinator = createSellerOrderActionCoordinator(dependencies);

    const firstResult = await coordinator.execute({
      session,
      order: makeOrder(),
      nextStatus: "confirmed",
    });
    expect(firstResult).toMatchObject({
      ok: false,
      code: "BUYER_NOTIFICATION_FAILED",
      progress: {
        serverPersisted: true,
        buyerNotified: false,
        giftWrap: statusGiftWrap,
      },
    });

    const retryResult = await coordinator.execute({
      session,
      order: makeOrder(),
      nextStatus: "confirmed",
      previousProgress: firstResult.progress,
    });

    expect(retryResult).toMatchObject({
      ok: true,
      progress: { serverPersisted: true, buyerNotified: true },
    });
    expect(dependencies.persistStatus).toHaveBeenCalledTimes(1);
    expect(dependencies.createStatusGiftWrap).toHaveBeenCalledTimes(1);
    expect(publishStatusGiftWrap).toHaveBeenCalledTimes(2);
    expect(publishStatusGiftWrap).toHaveBeenLastCalledWith({
      baseUrl: "http://127.0.0.1:5000",
      session,
      giftWrap: statusGiftWrap,
    });
  });

  it("recovers a relay failure after navigation or restart without re-signing", async () => {
    const outbox = createMemoryOutbox();
    const firstPublish = jest.fn(async () => {
      throw new Error("relay failure");
    });
    const firstDependencies = makeDependencies({
      outbox,
      publishStatusGiftWrap: firstPublish,
    });
    const firstCoordinator =
      createSellerOrderActionCoordinator(firstDependencies);

    await expect(
      firstCoordinator.execute({
        session,
        order: makeOrder(),
        nextStatus: "confirmed",
      })
    ).resolves.toMatchObject({
      ok: false,
      code: "BUYER_NOTIFICATION_FAILED",
    });

    const restartedPersist = jest.fn(async () => ({ persisted: true }));
    const restartedPublish = jest.fn(async () => undefined);
    const restartedDependencies = makeDependencies({
      outbox,
      persistStatus: restartedPersist,
      publishStatusGiftWrap: restartedPublish,
    });

    await retryPendingSellerOrderNotifications(session, restartedDependencies);
    await retryPendingSellerOrderNotifications(session, restartedDependencies);

    expect(restartedPersist).not.toHaveBeenCalled();
    expect(restartedPublish).toHaveBeenCalledTimes(1);
    expect(restartedPublish).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:5000",
      session,
      giftWrap: statusGiftWrap,
    });
  });

  it("recovers a crash after the server write without duplicating the transition", async () => {
    const persistedOutbox = createMemoryOutbox();
    const firstDependencies = makeDependencies({
      outbox: {
        ...persistedOutbox,
        markServerPersisted: jest.fn(async () => {
          throw new Error("storage interrupted");
        }),
      },
    });
    const firstCoordinator =
      createSellerOrderActionCoordinator(firstDependencies);

    await expect(
      firstCoordinator.execute({
        session,
        order: makeOrder(),
        nextStatus: "confirmed",
      })
    ).resolves.toMatchObject({
      ok: false,
      code: "OUTBOX_PERSISTENCE_FAILED",
      progress: { serverPersisted: true, buyerNotified: false },
    });
    expect(firstDependencies.publishStatusGiftWrap).not.toHaveBeenCalled();

    const idempotentServerRetry = jest.fn(async () => ({ persisted: true }));
    const restartedPublish = jest.fn(async () => undefined);
    const restartedDependencies = makeDependencies({
      outbox: persistedOutbox,
      persistStatus: idempotentServerRetry,
      publishStatusGiftWrap: restartedPublish,
    });
    await retryPendingSellerOrderNotifications(session, restartedDependencies);

    expect(idempotentServerRetry).toHaveBeenCalledTimes(1);
    expect(idempotentServerRetry).toHaveBeenCalledWith(
      expect.objectContaining({ transitionId: statusGiftWrap.id })
    );
    expect(restartedPublish).toHaveBeenCalledTimes(1);
    expect(restartedPublish).toHaveBeenCalledWith(
      expect.objectContaining({ giftWrap: statusGiftWrap })
    );
  });

  it("rejects a stale buyer-notification retry after the order moves to another status", async () => {
    const dependencies = makeDependencies();
    const coordinator = createSellerOrderActionCoordinator(dependencies);

    await expect(
      coordinator.execute({
        session,
        order: makeOrder({ status: "completed" }),
        nextStatus: "confirmed",
        previousProgress: {
          orderId: "order-123",
          nextStatus: "confirmed",
          sourceMessageId: wrapId,
          serverPersisted: true,
          buyerNotificationRequired: true,
          buyerNotified: false,
          giftWrap: statusGiftWrap,
        },
      })
    ).resolves.toMatchObject({ ok: false, code: "INVALID_RETRY" });

    expect(dependencies.publishStatusGiftWrap).not.toHaveBeenCalled();
  });

  it("does not publish when server persistence fails and can retry that step", async () => {
    const persistStatus = jest
      .fn()
      .mockRejectedValueOnce(new Error("server failure"))
      .mockResolvedValueOnce({ persisted: true });
    const dependencies = makeDependencies({ persistStatus });
    const coordinator = createSellerOrderActionCoordinator(dependencies);

    const firstResult = await coordinator.execute({
      session,
      order: makeOrder(),
      nextStatus: "confirmed",
    });
    expect(firstResult).toMatchObject({
      ok: false,
      code: "SERVER_PERSISTENCE_FAILED",
      progress: { serverPersisted: false, buyerNotified: false },
    });
    expect(dependencies.publishStatusGiftWrap).not.toHaveBeenCalled();

    const retryResult = await coordinator.execute({
      session,
      order: makeOrder(),
      nextStatus: "confirmed",
      previousProgress: firstResult.progress,
    });

    expect(retryResult).toMatchObject({
      ok: true,
      progress: { serverPersisted: true, buyerNotified: true },
    });
    expect(persistStatus).toHaveBeenCalledTimes(2);
    expect(dependencies.createStatusGiftWrap).toHaveBeenCalledTimes(1);
    expect(dependencies.publishStatusGiftWrap).toHaveBeenCalledTimes(1);
  });

  it("coalesces duplicate in-flight actions", async () => {
    let resolvePersistence: ((value: { persisted: true }) => void) | undefined;
    const persistence = new Promise<{ persisted: true }>((resolve) => {
      resolvePersistence = resolve;
    });
    const dependencies = makeDependencies({
      persistStatus: jest.fn(() => persistence),
    });
    const coordinator = createSellerOrderActionCoordinator(dependencies);
    const input = {
      session,
      order: makeOrder(),
      nextStatus: "confirmed" as const,
    };

    const first = coordinator.execute(input);
    const second = coordinator.execute(input);
    resolvePersistence?.({ persisted: true });

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
    expect(dependencies.persistStatus).toHaveBeenCalledTimes(1);
    expect(dependencies.publishStatusGiftWrap).toHaveBeenCalledTimes(1);
  });
});
