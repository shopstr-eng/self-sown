import type { SellerOrder, SellerSession } from "@milk-market/domain";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  createNip98AuthorizationHeader,
  createSellerMessagesListProof,
  createSellerOrderStatusGiftWrap,
  publishSellerOrderStatusGiftWrap,
  unwrapSellerOrderGiftWraps,
} from "@milk-market/nostr";
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
  fetchOrderStatuses: (orderIds, session) => {
    const body = JSON.stringify({ orderIds });
    const authorizationHeader = createNip98AuthorizationHeader({
      session,
      url: `${apiBaseUrl}/api/db/get-order-statuses`,
      method: "POST",
      body,
    });
    return mobileSellerOrdersApiClient.fetchOrderStatuses({
      orderIds,
      authorizationHeader,
    });
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
