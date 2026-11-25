/** @jest-environment node */

import {
  clearPrivateSellerOrderQueries,
  findSellerOrder,
  loadSellerOrdersForNotification,
  loadSellerOrdersPage,
  selectSellerOrders,
  sellerOrdersQueryKey,
  type SellerOrdersLoaderDependencies,
} from "../../apps/mobile/lib/order-query";
import { queryClient } from "../../apps/mobile/lib/query-client";
import type { CachedSellerMessage } from "@self-sown/api-client";
import type {
  SellerOrderEvent,
  SellerOrderStatus,
  SellerSession,
} from "@self-sown/domain";

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

const cachedMessage: CachedSellerMessage = {
  id: wrapId,
  pubkey: "c".repeat(64),
  created_at: 1_750_000_000,
  kind: 1059,
  tags: [["p", sellerPubkey]],
  content: "encrypted",
  sig: "d".repeat(128),
  is_read: false,
};

function makeRumor(
  overrides: Partial<SellerOrderEvent> = {}
): SellerOrderEvent {
  return {
    id: "2".repeat(64),
    pubkey: buyerPubkey,
    created_at: 1_750_000_000,
    kind: 14,
    tags: [
      ["p", sellerPubkey],
      ["subject", "order-info"],
      ["order", "order-123"],
      ["b", buyerPubkey],
      ["item", `30402:${sellerPubkey}:fresh-milk`, "2"],
      ["amount", "24.5"],
      ["currency", "USD"],
    ],
    content: "Product: Fresh Milk",
    read: false,
    wrappedEventId: wrapId,
    ...overrides,
  };
}

function makeDependencies(
  overrides: Partial<SellerOrdersLoaderDependencies> = {}
): SellerOrdersLoaderDependencies {
  return {
    createMessagesListProof: jest.fn(() => ({ id: "proof" })),
    fetchSellerMessages: jest.fn(async () => ({
      messages: [cachedMessage],
      rejectedMessageCount: 0,
      nextCursor: null,
    })),
    unwrapGiftWraps: jest.fn(async () => ({
      events: [makeRumor()],
      rejected: [],
    })),
    fetchOrderStatuses: jest.fn(async () => {
      const statuses: Partial<Record<string, SellerOrderStatus>> = {
        "order-123": "confirmed",
      };
      return statuses;
    }),
    ...overrides,
  };
}

async function loadSellerOrders(
  currentSession: SellerSession,
  dependencies: SellerOrdersLoaderDependencies
) {
  const page = await loadSellerOrdersPage(currentSession, dependencies, null);
  return selectSellerOrders({ pages: [page], pageParams: [null] });
}

describe("seller order query orchestration", () => {
  it("uses seller-scoped private query keys", () => {
    expect(sellerOrdersQueryKey(sellerPubkey)).toEqual([
      "seller-orders",
      sellerPubkey,
    ]);
    expect(sellerOrdersQueryKey("e".repeat(64))).not.toEqual(
      sellerOrdersQueryKey(sellerPubkey)
    );
  });

  it("loads, isolates, parses, and consolidates messages without exposing rejections", async () => {
    const malformedRumor = makeRumor({
      id: "3".repeat(64),
      tags: makeRumor().tags.map((tag) =>
        tag[0] === "item"
          ? ["item", `30402:${"f".repeat(64)}:foreign`, "1"]
          : tag
      ),
    });
    const dependencies = makeDependencies({
      fetchSellerMessages: jest.fn(async () => ({
        messages: [cachedMessage],
        rejectedMessageCount: 1,
        nextCursor: null,
      })),
      unwrapGiftWraps: jest.fn(async () => ({
        events: [makeRumor(), malformedRumor],
        rejected: [
          {
            wrappedEventId: "4".repeat(64),
            reason: "invalid-envelope" as const,
          },
        ],
      })),
    });

    const result = await loadSellerOrders(session, dependencies);

    expect(dependencies.createMessagesListProof).toHaveBeenCalledWith(session);
    expect(dependencies.fetchSellerMessages).toHaveBeenCalledWith({
      sellerPubkey,
      signedEvent: { id: "proof" },
      cursor: null,
    });
    expect(dependencies.unwrapGiftWraps).toHaveBeenCalledWith({
      session,
      giftWraps: [
        {
          ...cachedMessage,
          is_read: false,
        },
      ],
    });
    expect(dependencies.fetchOrderStatuses).toHaveBeenCalledWith(
      ["order-123"],
      session
    );
    expect(result).toMatchObject({
      rejectedMessageCount: 3,
      orders: [
        {
          orderId: "order-123",
          productTitle: "Fresh Milk",
          status: "confirmed",
          unread: true,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("invalid-envelope");
  });

  it("returns an empty result without calling the status route", async () => {
    const fetchOrderStatuses = jest.fn();
    const dependencies = makeDependencies({
      unwrapGiftWraps: jest.fn(async () => ({ events: [], rejected: [] })),
      fetchOrderStatuses,
    });

    await expect(loadSellerOrders(session, dependencies)).resolves.toEqual({
      orders: [],
      rejectedMessageCount: 0,
    });
    expect(fetchOrderStatuses).not.toHaveBeenCalled();
  });

  it("finds an order by exact ID", async () => {
    const result = await loadSellerOrders(session, makeDependencies());

    expect(findSellerOrder(result, "order-123")?.productTitle).toBe(
      "Fresh Milk"
    );
    expect(findSellerOrder(result, "missing")).toBeNull();
  });

  it("joins an older order detail with its newer update across pages", async () => {
    const cursor = `1750000000:${"5".repeat(64)}`;
    const updateWrap = "5".repeat(64);
    const fetchSellerMessages = jest.fn(
      async ({ cursor: previous }: { cursor: string | null }) => ({
        messages: [
          previous ? cachedMessage : { ...cachedMessage, id: updateWrap },
        ],
        rejectedMessageCount: previous ? 1 : 2,
        nextCursor: previous ? null : cursor,
      })
    );
    const dependencies = makeDependencies({
      fetchSellerMessages,
      unwrapGiftWraps: jest.fn(async ({ giftWraps }) => ({
        events: giftWraps.map(({ id }) =>
          id === wrapId
            ? makeRumor({
                tags: [...makeRumor().tags, ["address", "Farm Road"]],
              })
            : makeRumor({
                id: "6".repeat(64),
                wrappedEventId: updateWrap,
                created_at: 1_750_000_001,
                tags: makeRumor().tags.map((tag) =>
                  tag[0] === "subject" ? ["subject", "shipping-info"] : tag
                ),
              })
        ),
        rejected: [],
      })),
    });

    const newer = await loadSellerOrdersPage(session, dependencies, null);
    expect(fetchSellerMessages).toHaveBeenCalledTimes(1);
    const older = await loadSellerOrdersPage(
      session,
      dependencies,
      newer.nextCursor
    );
    const result = selectSellerOrders({
      pages: [newer, older],
      pageParams: [null, cursor],
    });

    expect(result.rejectedMessageCount).toBe(3);
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0]).toMatchObject({
      orderId: "order-123",
      address: "Farm Road",
      wrappedEventIds: [wrapId, updateWrap],
    });
    expect(result.orders[0]?.history.map(({ subject }) => subject)).toEqual([
      "order-info",
      "shipping-info",
    ]);

    fetchSellerMessages.mockClear();
    await expect(
      loadSellerOrdersForNotification(session, dependencies, () => true)
    ).resolves.toMatchObject([{ orderId: "order-123", address: "Farm Road" }]);
    expect(
      fetchSellerMessages.mock.calls.map(([request]) => request.cursor)
    ).toEqual([null, cursor]);
  });

  it("removes every private order query while preserving unrelated cache data", async () => {
    queryClient.clear();
    queryClient.setQueryData(sellerOrdersQueryKey(sellerPubkey), {
      private: "seller-a",
    });
    queryClient.setQueryData(sellerOrdersQueryKey("e".repeat(64)), {
      private: "seller-b",
    });
    queryClient.setQueryData(["seller-listings", sellerPubkey], ["listing"]);

    await clearPrivateSellerOrderQueries(queryClient);

    expect(queryClient.getQueryData(sellerOrdersQueryKey(sellerPubkey))).toBe(
      undefined
    );
    expect(queryClient.getQueryData(sellerOrdersQueryKey("e".repeat(64)))).toBe(
      undefined
    );
    expect(queryClient.getQueryData(["seller-listings", sellerPubkey])).toEqual(
      ["listing"]
    );
  });

  it("can remove only the previous seller during an account switch", async () => {
    queryClient.clear();
    const nextSeller = "e".repeat(64);
    queryClient.setQueryData(sellerOrdersQueryKey(sellerPubkey), {
      private: "seller-a",
    });
    queryClient.setQueryData(sellerOrdersQueryKey(nextSeller), {
      private: "seller-b",
    });

    await clearPrivateSellerOrderQueries(queryClient, sellerPubkey);

    expect(queryClient.getQueryData(sellerOrdersQueryKey(sellerPubkey))).toBe(
      undefined
    );
    expect(queryClient.getQueryData(sellerOrdersQueryKey(nextSeller))).toEqual({
      private: "seller-b",
    });
  });
});
