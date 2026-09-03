import type { QueryClient } from "@tanstack/react-query";

import type { CachedSellerMessage } from "@milk-market/api-client";
import {
  consolidateSellerOrders,
  parseSellerOrderMessage,
  type SellerOrder,
  type SellerOrderStatus,
  type SellerSession,
} from "@milk-market/domain";
import type {
  CachedSellerGiftWrap,
  SellerOrderGiftWrapBatchResult,
} from "@milk-market/nostr";

export const SELLER_ORDERS_QUERY_ROOT = ["seller-orders"] as const;

export interface SellerOrdersQueryData {
  orders: SellerOrder[];
  rejectedMessageCount: number;
}

export interface SellerOrdersLoaderDependencies {
  createMessagesListProof: (session: SellerSession) => unknown;
  fetchSellerMessages: (input: {
    sellerPubkey: string;
    signedEvent: unknown;
  }) => Promise<{
    messages: CachedSellerMessage[];
    rejectedMessageCount: number;
  }>;
  unwrapGiftWraps: (input: {
    session: SellerSession;
    giftWraps: CachedSellerGiftWrap[];
  }) => Promise<SellerOrderGiftWrapBatchResult>;
  fetchOrderStatuses: (
    orderIds: string[],
    session: SellerSession
  ) => Promise<Partial<Record<string, SellerOrderStatus>>>;
}

export function sellerOrdersQueryKey(pubkey: string) {
  return [...SELLER_ORDERS_QUERY_ROOT, pubkey] as const;
}

function toCachedGiftWrap(message: CachedSellerMessage): CachedSellerGiftWrap {
  return {
    id: message.id,
    pubkey: message.pubkey,
    created_at: message.created_at,
    kind: 1059,
    tags: message.tags,
    content: message.content,
    sig: message.sig,
    is_read: message.is_read,
  };
}

export async function loadSellerOrders(
  session: SellerSession,
  dependencies: SellerOrdersLoaderDependencies
): Promise<SellerOrdersQueryData> {
  const signedEvent = dependencies.createMessagesListProof(session);
  const cachedResult = await dependencies.fetchSellerMessages({
    sellerPubkey: session.pubkey,
    signedEvent,
  });
  const unwrapResult = await dependencies.unwrapGiftWraps({
    session,
    giftWraps: cachedResult.messages.map(toCachedGiftWrap),
  });

  let rejectedMessageCount =
    cachedResult.rejectedMessageCount + unwrapResult.rejected.length;
  const parsedMessages = unwrapResult.events.flatMap((event) => {
    const parsed = parseSellerOrderMessage(event, session.pubkey);
    if (!parsed) {
      rejectedMessageCount += 1;
      return [];
    }
    return [parsed];
  });

  if (parsedMessages.length === 0) {
    return { orders: [], rejectedMessageCount };
  }

  const orderIds = Array.from(
    new Set(parsedMessages.map((message) => message.orderId))
  );
  const statuses = await dependencies.fetchOrderStatuses(orderIds, session);
  return {
    orders: consolidateSellerOrders(parsedMessages, statuses),
    rejectedMessageCount,
  };
}

export function findSellerOrder(
  data: SellerOrdersQueryData | undefined,
  orderId: string
): SellerOrder | null {
  return data?.orders.find((order) => order.orderId === orderId) ?? null;
}

export async function clearPrivateSellerOrderQueries(
  client: QueryClient,
  pubkey?: string
): Promise<void> {
  const queryKey = pubkey
    ? sellerOrdersQueryKey(pubkey)
    : SELLER_ORDERS_QUERY_ROOT;
  await client.cancelQueries({ queryKey });
  client.removeQueries({ queryKey });
}
