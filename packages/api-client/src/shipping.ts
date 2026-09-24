import {
  isSafeShippingUrl,
  type SellerParcel,
  type SellerShippingAddress,
} from "@milk-market/domain";

export type SellerShippingApiErrorCode =
  | "INVALID_REQUEST"
  | "REQUEST_FAILED"
  | "INVALID_RESPONSE";

export class SellerShippingApiError extends Error {
  public readonly status: number;
  public readonly code: SellerShippingApiErrorCode;

  constructor(
    message: string,
    status: number,
    code: SellerShippingApiErrorCode
  ) {
    super(message);
    this.name = "SellerShippingApiError";
    this.status = status;
    this.code = code;
  }
}

export interface SellerShippingRate {
  id: string;
  shipmentId: string;
  carrier: string;
  service: string;
  rate: number;
  currency: string;
  deliveryDays?: number | null;
  estDeliveryDate?: string | null;
}

export interface SellerShippingLabel {
  id: number | null;
  shipmentId: string;
  orderId?: string | null;
  trackingCode: string | null;
  trackingUrl?: string | null;
  labelUrl: string;
  labelFormat: string | null;
  rateUsd?: number;
  rate?: number;
  currency: string;
  carrier: string | null;
  service: string | null;
  isReturn?: boolean;
  fromSummary?: unknown;
  toSummary?: unknown;
  parcelSummary?: unknown;
  purchasedAt?: string;
}

export interface SellerShippingConnectionStatus {
  configured: boolean;
  connected: boolean;
  accountId: string | null;
  scope?: string | null;
  connectedAt?: string | null;
}

export interface SellerShippingDefaults {
  fromName: string | null;
  fromCompany: string | null;
  fromStreet1: string | null;
  fromStreet2: string | null;
  fromCity: string | null;
  fromState: string | null;
  fromZip: string | null;
  fromCountry: string;
  fromPhone: string | null;
  fromEmail: string | null;
  preferredCarriers: string[];
  autoPurchaseLabels: boolean;
}

export interface QuoteOrderShippingBody {
  orderId: string;
  to: SellerShippingAddress;
  parcel: SellerParcel;
}

export interface BuyOrderLabelBody {
  orderId: string;
  shipmentId: string;
  rateId: string;
}

export interface CreateSellerShippingApiClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface SellerShippingAuthorizationRequest {
  path: string;
  method: "GET" | "POST";
  body?: string;
}

export type SellerShippingAuthorization =
  | {
      authorizationHeader: string;
      authorize?: never;
    }
  | {
      authorizationHeader?: never;
      authorize: (request: SellerShippingAuthorizationRequest) => string;
    };

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const ORDER_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const PROVIDER_ID = /^[A-Za-z0-9._:-]{1,256}$/;
const MAX_AUTHORIZATION_LENGTH = 32_768;
const MAX_LABELS = 1_000;

function invalidRequest(message: string): SellerShippingApiError {
  return new SellerShippingApiError(message, 0, "INVALID_REQUEST");
}

function invalidResponse(status: number): SellerShippingApiError {
  return new SellerShippingApiError(
    "The seller shipping service returned an invalid response.",
    status,
    "INVALID_RESPONSE"
  );
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function joinUrl(baseUrl: string, path: string): string {
  return baseUrl ? `${trimTrailingSlash(baseUrl)}${path}` : path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateAuthorizationHeader(value: string): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("Nostr ") ||
    value.length > MAX_AUTHORIZATION_LENGTH ||
    CONTROL_CHARACTERS.test(value)
  ) {
    throw invalidRequest("A valid NIP-98 authorization header is required.");
  }
  return value;
}

function validateOrderId(value: string): string {
  const orderId = value.trim();
  if (!ORDER_ID.test(orderId)) {
    throw invalidRequest("A valid order ID is required.");
  }
  return orderId;
}

function validateProviderId(value: string, label: string): string {
  const id = value.trim();
  if (!PROVIDER_ID.test(id)) {
    throw invalidRequest(`A valid ${label} is required.`);
  }
  return id;
}

function safeServerError(payload: unknown, status: number): string {
  if (
    isRecord(payload) &&
    typeof payload.error === "string" &&
    payload.error.length > 0 &&
    payload.error.length <= 240 &&
    !CONTROL_CHARACTERS.test(payload.error)
  ) {
    return payload.error;
  }
  return `Seller shipping request failed with status ${status}.`;
}

function isRate(value: unknown): value is SellerShippingRate {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.shipmentId === "string" &&
    typeof value.carrier === "string" &&
    typeof value.service === "string" &&
    typeof value.rate === "number" &&
    Number.isFinite(value.rate) &&
    typeof value.currency === "string"
  );
}

function isLabel(value: unknown): value is SellerShippingLabel {
  return (
    isRecord(value) &&
    (value.id === null ||
      (typeof value.id === "number" && Number.isSafeInteger(value.id))) &&
    typeof value.shipmentId === "string" &&
    isNullableString(value.trackingCode) &&
    (value.trackingUrl === undefined ||
      value.trackingUrl === null ||
      typeof value.trackingUrl === "string") &&
    typeof value.labelUrl === "string" &&
    isNullableString(value.labelFormat) &&
    (typeof value.rateUsd === "number" || typeof value.rate === "number") &&
    typeof value.currency === "string" &&
    isNullableString(value.carrier) &&
    isNullableString(value.service)
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function parseDefaults(
  value: unknown,
  status: number
): SellerShippingDefaults | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !isNullableString(value.fromName) ||
    !isNullableString(value.fromCompany) ||
    !isNullableString(value.fromStreet1) ||
    !isNullableString(value.fromStreet2) ||
    !isNullableString(value.fromCity) ||
    !isNullableString(value.fromState) ||
    !isNullableString(value.fromZip) ||
    typeof value.fromCountry !== "string" ||
    !isNullableString(value.fromPhone) ||
    !isNullableString(value.fromEmail) ||
    !Array.isArray(value.preferredCarriers) ||
    !value.preferredCarriers.every((carrier) => typeof carrier === "string") ||
    typeof value.autoPurchaseLabels !== "boolean"
  ) {
    throw invalidResponse(status);
  }
  return value as unknown as SellerShippingDefaults;
}

export function createSellerShippingApiClient(
  options: CreateSellerShippingApiClientOptions = {}
) {
  const baseUrl = options.baseUrl ?? "";
  const fetchImpl = options.fetchImpl ?? fetch;

  async function requestJson(
    path: string,
    init: RequestInit
  ): Promise<{ payload: unknown; status: number }> {
    let response: Response;
    try {
      response = await fetchImpl(joinUrl(baseUrl, path), init);
    } catch {
      throw new SellerShippingApiError(
        "Unable to reach the seller shipping service.",
        0,
        "REQUEST_FAILED"
      );
    }

    let payload: unknown;
    try {
      const text = await response.text();
      payload = text ? (JSON.parse(text) as unknown) : undefined;
    } catch {
      throw invalidResponse(response.status);
    }

    if (!response.ok) {
      throw new SellerShippingApiError(
        safeServerError(payload, response.status),
        response.status,
        "REQUEST_FAILED"
      );
    }
    return { payload, status: response.status };
  }

  function headers(
    authorization: SellerShippingAuthorization,
    request: SellerShippingAuthorizationRequest
  ): Headers {
    const authorizationHeader = authorization.authorize
      ? authorization.authorize(request)
      : authorization.authorizationHeader;
    return new Headers({
      Accept: "application/json",
      Authorization: validateAuthorizationHeader(authorizationHeader),
      "Content-Type": "application/json",
    });
  }

  return {
    async getConnectionStatus(request: SellerShippingAuthorization) {
      const path = "/api/shipping/oauth/status";
      const { payload, status } = await requestJson(path, {
        method: "GET",
        headers: headers(request, { path, method: "GET" }),
      });
      if (
        !isRecord(payload) ||
        typeof payload.configured !== "boolean" ||
        typeof payload.connected !== "boolean" ||
        !isNullableString(payload.accountId)
      ) {
        throw invalidResponse(status);
      }
      return payload as unknown as SellerShippingConnectionStatus;
    },

    async startOAuth(request: SellerShippingAuthorization) {
      const path = "/api/shipping/oauth/start";
      const body = { returnTarget: "mobile" as const };
      const serializedBody = JSON.stringify(body);
      const { payload, status } = await requestJson(path, {
        method: "POST",
        headers: headers(request, {
          path,
          method: "POST",
          body: serializedBody,
        }),
        body: serializedBody,
      });
      if (
        !isRecord(payload) ||
        payload.success !== true ||
        typeof payload.authorizeUrl !== "string" ||
        !isSafeShippingUrl(payload.authorizeUrl)
      ) {
        throw invalidResponse(status);
      }
      return payload.authorizeUrl;
    },

    async disconnectOAuth(request: SellerShippingAuthorization) {
      const path = "/api/shipping/oauth/disconnect";
      const body = {};
      const serializedBody = JSON.stringify(body);
      const { payload, status } = await requestJson(path, {
        method: "POST",
        headers: headers(request, {
          path,
          method: "POST",
          body: serializedBody,
        }),
        body: serializedBody,
      });
      if (!isRecord(payload) || payload.success !== true) {
        throw invalidResponse(status);
      }
    },

    async getDefaults(request: SellerShippingAuthorization) {
      const path = "/api/shipping/defaults";
      const { payload, status } = await requestJson(path, {
        method: "GET",
        headers: headers(request, { path, method: "GET" }),
      });
      if (!isRecord(payload) || payload.success !== true) {
        throw invalidResponse(status);
      }
      return parseDefaults(payload.defaults, status);
    },

    async saveDefaults(
      request: SellerShippingAuthorization & {
        body: SellerShippingDefaults;
      }
    ) {
      const path = "/api/shipping/defaults";
      const body = JSON.stringify(request.body);
      const { payload, status } = await requestJson(path, {
        method: "POST",
        headers: headers(request, { path, method: "POST", body }),
        body,
      });
      if (!isRecord(payload) || payload.success !== true) {
        throw invalidResponse(status);
      }
      return parseDefaults(payload.defaults, status);
    },

    async listLabels(
      request: SellerShippingAuthorization & {
        orderId?: string;
      }
    ): Promise<SellerShippingLabel[]> {
      const query = request.orderId
        ? `?${new URLSearchParams({ orderId: validateOrderId(request.orderId) })}`
        : "";
      const path = `/api/shipping/labels${query}`;
      const { payload, status } = await requestJson(path, {
        method: "GET",
        headers: headers(request, { path, method: "GET" }),
      });
      if (
        !isRecord(payload) ||
        payload.success !== true ||
        !Array.isArray(payload.labels) ||
        payload.labels.length > MAX_LABELS ||
        !payload.labels.every(isLabel)
      ) {
        throw invalidResponse(status);
      }
      return payload.labels;
    },

    async quoteOrder(
      request: SellerShippingAuthorization & {
        body: QuoteOrderShippingBody;
      }
    ): Promise<{ shipmentId: string; rates: SellerShippingRate[] }> {
      const body = {
        ...request.body,
        orderId: validateOrderId(request.body.orderId),
      };
      const path = "/api/shipping/rates";
      const serializedBody = JSON.stringify(body);
      const { payload, status } = await requestJson(path, {
        method: "POST",
        headers: headers(request, {
          path,
          method: "POST",
          body: serializedBody,
        }),
        body: serializedBody,
      });
      if (
        !isRecord(payload) ||
        payload.success !== true ||
        typeof payload.shipmentId !== "string" ||
        !Array.isArray(payload.rates) ||
        !payload.rates.every(isRate)
      ) {
        throw invalidResponse(status);
      }
      return { shipmentId: payload.shipmentId, rates: payload.rates };
    },

    async buyOrderLabel(
      request: SellerShippingAuthorization & {
        body: BuyOrderLabelBody;
      }
    ): Promise<SellerShippingLabel> {
      const body = {
        orderId: validateOrderId(request.body.orderId),
        shipmentId: validateProviderId(request.body.shipmentId, "shipment ID"),
        rateId: validateProviderId(request.body.rateId, "rate ID"),
      };
      const path = "/api/shipping/buy-label";
      const serializedBody = JSON.stringify(body);
      const { payload, status } = await requestJson(path, {
        method: "POST",
        headers: headers(request, {
          path,
          method: "POST",
          body: serializedBody,
        }),
        body: serializedBody,
      });
      if (!isRecord(payload) || payload.success !== true || !isLabel(payload)) {
        throw invalidResponse(status);
      }
      return payload;
    },
  };
}

export type SellerShippingApiClient = ReturnType<
  typeof createSellerShippingApiClient
>;
