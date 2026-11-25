import { MAX_ORDER_STATUS_IDS_PER_REQUEST } from "@self-sown/api-client";
import type {
  SellerOrder,
  SellerOrderStatus,
  SellerSession,
} from "@self-sown/domain";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  createNip98AuthorizationHeader,
  createSellerMessagesListProof,
  createSellerOrderStatusGiftWrap,
  publishSellerOrderStatusGiftWrap,
  unwrapSellerOrderGiftWraps,
} from "@self-sown/nostr";
import { verifyEvent } from "nostr-tools";

import { getApiBaseUrl } from "@/lib/api-base-url";
import { mobileSellerOrdersApiClient } from "@/lib/api-client";
import {
  createSellerOrderActionCoordinator,
  retryPendingSellerOrderNotifications,
  type SellerOrderActionDependencies,
} from "@/lib/order-actions";
import { createSellerOrderNotificationOutbox } from "@/lib/order-notification-outbox";
import type { SellerOrdersLoaderDependencies } from "@/lib/order-query";
import { createSecureOutboxStorage } from "@/lib/secure-outbox-storage";

const apiBaseUrl = getApiBaseUrl();

export const sellerOrdersLoaderDependencies: SellerOrdersLoaderDependencies = {
  createMessagesListProof: createSellerMessagesListProof,
  fetchSellerMessages: (input) =>
    mobileSellerOrdersApiClient.fetchSellerMessages(input),
  unwrapGiftWraps: unwrapSellerOrderGiftWraps,
  fetchOrderStatuses: async (orderIds, session) => {
    const statuses: Partial<Record<string, SellerOrderStatus>> = {};
    for (
      let offset = 0;
      offset < orderIds.length;
      offset += MAX_ORDER_STATUS_IDS_PER_REQUEST
    ) {
      const batch = orderIds.slice(
        offset,
        offset + MAX_ORDER_STATUS_IDS_PER_REQUEST
      );
      const body = JSON.stringify({ orderIds: batch });
      const authorizationHeader = createNip98AuthorizationHeader({
        session,
        url: `${apiBaseUrl}/api/db/get-order-statuses`,
        method: "POST",
        body,
      });
      const batchStatuses =
        await mobileSellerOrdersApiClient.fetchOrderStatuses({
          orderIds: batch,
          authorizationHeader,
        });
      Object.assign(statuses, batchStatuses);
    }
    return statuses;
  },
};

const notificationOutbox = createSellerOrderNotificationOutbox({
  storage: createSecureOutboxStorage(AsyncStorage),
  verifyEvent,
});

const sellerOrderActionDependencies: SellerOrderActionDependencies = {
  apiBaseUrl,
  createStatusGiftWrap: createSellerOrderStatusGiftWrap,
  createAuthorizationHeader: createNip98AuthorizationHeader,
  persistStatus: async (input) => {
    const response = await mobileSellerOrdersApiClient.updateOrderStatus(input);
    return { persisted: response.persisted };
  },
  publishStatusGiftWrap: publishSellerOrderStatusGiftWrap,
  outbox: notificationOutbox,
};

export const mobileSellerOrderActionCoordinator =
  createSellerOrderActionCoordinator(sellerOrderActionDependencies);

export function retryPendingMobileSellerOrderNotifications(
  session: SellerSession
): Promise<void> {
  return retryPendingSellerOrderNotifications(
    session,
    sellerOrderActionDependencies
  );
}

export async function markSellerOrderMessagesRead(
  session: SellerSession,
  order: SellerOrder
): Promise<void> {
  const messageIds = Array.from(new Set(order.wrappedEventIds));
  if (messageIds.length === 0) {
    return;
  }

  const body = JSON.stringify({ messageIds });
  const authorizationHeader = createNip98AuthorizationHeader({
    session,
    url: `${apiBaseUrl}/api/db/mark-messages-read`,
    method: "POST",
    body,
  });
  await mobileSellerOrdersApiClient.markMessagesRead({
    messageIds,
    authorizationHeader,
  });
}
