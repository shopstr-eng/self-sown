import {
  createSelfSownApiClient,
  createSellerOrdersApiClient,
} from "@self-sown/api-client";

import { getApiBaseUrl } from "@/lib/api-base-url";

export const mobileApiClient = createSelfSownApiClient({
  baseUrl: getApiBaseUrl(),
});

export const mobileSellerOrdersApiClient = createSellerOrdersApiClient({
  baseUrl: getApiBaseUrl(),
});
