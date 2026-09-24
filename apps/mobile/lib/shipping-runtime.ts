import type {
  BuyOrderLabelBody,
  QuoteOrderShippingBody,
  SellerShippingDefaults,
} from "@milk-market/api-client";
import type { SellerSession } from "@milk-market/domain";
import { createNip98AuthorizationHeader } from "@milk-market/nostr";

import { getApiBaseUrl } from "@/lib/api-base-url";
import { mobileSellerShippingApiClient } from "@/lib/api-client";

const apiBaseUrl = getApiBaseUrl();

function authorization(session: SellerSession) {
  return ({
    path,
    method,
    body,
  }: {
    path: string;
    method: "GET" | "POST";
    body?: string;
  }) =>
    createNip98AuthorizationHeader({
      session,
      url: `${apiBaseUrl}${path}`,
      method,
      ...(body !== undefined ? { body } : {}),
    });
}

export async function loadSellerShipping(session: SellerSession) {
  const [connection, defaults, labels] = await Promise.all([
    mobileSellerShippingApiClient.getConnectionStatus({
      authorize: authorization(session),
    }),
    mobileSellerShippingApiClient.getDefaults({
      authorize: authorization(session),
    }),
    mobileSellerShippingApiClient.listLabels({
      authorize: authorization(session),
    }),
  ]);
  return { connection, defaults, labels };
}

export function startSellerShippingOAuth(session: SellerSession) {
  return mobileSellerShippingApiClient.startOAuth({
    authorize: authorization(session),
  });
}

export function disconnectSellerShipping(session: SellerSession) {
  return mobileSellerShippingApiClient.disconnectOAuth({
    authorize: authorization(session),
  });
}

export function saveSellerShippingDefaults(
  session: SellerSession,
  defaults: SellerShippingDefaults
) {
  return mobileSellerShippingApiClient.saveDefaults({
    body: defaults,
    authorize: authorization(session),
  });
}

export function quoteSellerOrderShipping(
  session: SellerSession,
  input: QuoteOrderShippingBody
) {
  return mobileSellerShippingApiClient.quoteOrder({
    body: input,
    authorize: authorization(session),
  });
}

export function buySellerOrderLabel(
  session: SellerSession,
  input: BuyOrderLabelBody
) {
  return mobileSellerShippingApiClient.buyOrderLabel({
    body: input,
    authorize: authorization(session),
  });
}

export function listSellerOrderLabels(session: SellerSession, orderId: string) {
  return mobileSellerShippingApiClient.listLabels({
    orderId,
    authorize: authorization(session),
  });
}
