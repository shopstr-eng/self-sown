import type { InfiniteData, QueryClient } from "@tanstack/react-query";

import type { CachedSellerMessage } from "@self-sown/api-client";
import {
  consolidateSellerOrders,
  parseSellerOrderMessage,
  type SellerOrder,
  type SellerOrderMessage,
  type SellerOrderStatus,
  type SellerSession,
} from "@self-sown/domain";
import type {
  CachedSellerGiftWrap,
  SellerOrderGiftWrapBatchResult,
} from "@self-sown/nostr";

export const SELLER_ORDERS_QUERY_ROOT = ["seller-orders"] as const;

export interface SellerOrdersQueryData {
  orders: SellerOrder[];
  rejectedMessageCount: number;
}

export interface SellerOrdersPage {
  messages: SellerOrderMessage[];
  statuses: Partial<Record<string, SellerOrderStatus>>;
  rejectedMessageCount: number;
  nextCursor: string | null;
}

export type SellerOrdersPages = InfiniteData<SellerOrdersPage, string | null>;

export interface SellerOrdersLoaderDependencies {
  createMessagesListProof: (session: SellerSession) => unknown;
  fetchSellerMessages: (input: {
    sellerPubkey: string;
    signedEvent: unknown;
    cursor: string | null;
  }) => Promise<{
    messages: CachedSellerMessage[];
    rejectedMessageCount: number;
    nextCursor: string | null;
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

export async function loadSellerOrdersPage(
  session: SellerSession,
  dependencies: SellerOrdersLoaderDependencies,
  cursor: string | null
): Promise<SellerOrdersPage> {
  const signedEvent = dependencies.createMessagesListProof(session);
  const cachedResult = await dependencies.fetchSellerMessages({
    sellerPubkey: session.pubkey,
    signedEvent,
    cursor,
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

  const orderIds = Array.from(
    new Set(parsedMessages.map((message) => message.orderId))
  );
  const statuses = orderIds.length
    ? await dependencies.fetchOrderStatuses(orderIds, session)
    : {};
  return {
    messages: parsedMessages,
    statuses,
    rejectedMessageCount,
    nextCursor: cachedResult.nextCursor,
  };
}

export function selectSellerOrders({
  pages,
}: SellerOrdersPages): SellerOrdersQueryData {
  const messages = pages.flatMap((page) => page.messages);
  const statuses: Partial<Record<string, SellerOrderStatus>> = {};
  for (const page of pages) Object.assign(statuses, page.statuses);
  return {
    orders: consolidateSellerOrders(messages, statuses),
    rejectedMessageCount: pages.reduce(
      (count, page) => count + page.rejectedMessageCount,
      0
    ),
  };
}

export async function loadSellerOrdersForNotification(
  session: SellerSession,
  dependencies: SellerOrdersLoaderDependencies,
  isCurrent: () => boolean
): Promise<SellerOrder[]> {
  const pages: SellerOrdersPages = { pages: [], pageParams: [] };
  let cursor: string | null = null;
  do {
    const page = await loadSellerOrdersPage(session, dependencies, cursor);
    if (!isCurrent()) return [];
    pages.pages.push(page);
    pages.pageParams.push(cursor);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return selectSellerOrders(pages).orders;
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
