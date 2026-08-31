import {
  SELLER_ORDER_STATUSES,
  type SellerOrderStatus,
} from "@milk-market/domain";

export type SellerOrdersApiErrorCode =
  | "INVALID_REQUEST"
  | "REQUEST_FAILED"
  | "INVALID_RESPONSE";

export class SellerOrdersApiError extends Error {
  public readonly status: number;
  public readonly code: SellerOrdersApiErrorCode;

  constructor(message: string, status: number, code: SellerOrdersApiErrorCode) {
    super(message);
    this.name = "SellerOrdersApiError";
    this.status = status;
    this.code = code;
  }
}

export interface CachedSellerMessage {
  id: string;
  pubkey: string;
  created_at: number;
  kind: 1059;
  tags: string[][];
  content: string;
  sig: string;
  is_read: boolean;
}

export interface CachedSellerMessagesResult {
  messages: CachedSellerMessage[];
  rejectedMessageCount: number;
}

export interface SellerMessagesRequest {
  sellerPubkey: string;
  signedEvent: unknown;
}

export interface MarkSellerMessagesReadRequest {
  messageIds: string[];
  authorizationHeader: string;
}

export interface FetchSellerOrderStatusesRequest {
  orderIds: string[];
  authorizationHeader: string;
}

export interface UpdateSellerOrderStatusRequest {
  orderId: string;
  sellerPubkey: string;
  buyerPubkey: string | null;
  expectedStatus: "pending" | "confirmed" | "shipped";
  status: "confirmed" | "shipped" | "completed";
  messageId?: string;
  transitionId: string;
  authorizationHeader: string;
}

export interface UpdateSellerOrderStatusResponse {
  success: true;
  orderId: string;
  status: "confirmed" | "shipped" | "completed";
  persisted: boolean;
  version: number;
}

export interface CreateSellerOrdersApiClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_128 = /^[0-9a-f]{128}$/;
const ORDER_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const MAX_ORDER_IDS = 200;
const MAX_MESSAGE_IDS = 200;
const MAX_MESSAGES = 1000;
const MAX_ENCRYPTED_CONTENT_LENGTH = 262_144;
const MAX_AUTHORIZATION_LENGTH = 32_768;
const MAX_PROOF_HEADER_LENGTH = 32_768;
const STATUS_SET = new Set<string>(SELLER_ORDER_STATUSES);
const SELLER_STATUS_SET = new Set<string>([
  "confirmed",
  "shipped",
  "completed",
]);
const EXPECTED_STATUS_BY_TARGET = {
  confirmed: "pending",
  shipped: "confirmed",
  completed: "shipped",
} as const;
const TRANSITION_ID = /^[A-Za-z0-9._:-]{1,160}$/;

function invalidRequest(message: string): SellerOrdersApiError {
  return new SellerOrdersApiError(message, 0, "INVALID_REQUEST");
}

function invalidResponse(status: number): SellerOrdersApiError {
  return new SellerOrdersApiError(
    "The seller orders service returned an invalid response.",
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

function isStringTags(value: unknown): value is string[][] {
  return (
    Array.isArray(value) &&
    value.length <= 128 &&
    value.every(
      (tag) =>
        Array.isArray(tag) &&
        tag.length > 0 &&
        tag.length <= 8 &&
        tag.every((part) => typeof part === "string" && part.length <= 8192)
    )
  );
}

function parseCachedSellerMessages(
  payload: unknown,
  sellerPubkey: string,
  status: number
): CachedSellerMessagesResult {
  if (!Array.isArray(payload) || payload.length > MAX_MESSAGES) {
    throw invalidResponse(status);
  }

  const messages: CachedSellerMessage[] = [];
  let rejectedMessageCount = 0;
  for (const item of payload) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      !HEX_64.test(item.id) ||
      typeof item.pubkey !== "string" ||
      !HEX_64.test(item.pubkey) ||
      typeof item.created_at !== "number" ||
      !Number.isSafeInteger(item.created_at) ||
      item.created_at < 0 ||
      item.kind !== 1059 ||
      !isStringTags(item.tags) ||
      !item.tags.some((tag) => tag[0] === "p" && tag[1] === sellerPubkey) ||
      typeof item.content !== "string" ||
      item.content.length === 0 ||
      item.content.length > MAX_ENCRYPTED_CONTENT_LENGTH ||
      typeof item.sig !== "string" ||
      !HEX_128.test(item.sig) ||
      typeof item.is_read !== "boolean"
    ) {
      rejectedMessageCount += 1;
      continue;
    }

    messages.push({
      id: item.id,
      pubkey: item.pubkey,
      created_at: item.created_at,
      kind: 1059,
      tags: item.tags,
      content: item.content,
      sig: item.sig,
      is_read: item.is_read,
    });
  }

  return { messages, rejectedMessageCount };
}

function normalizeOrderIds(orderIds: string[]): string[] {
  if (!Array.isArray(orderIds)) {
    throw invalidRequest("Order IDs must be an array.");
  }

  const normalized = Array.from(
    new Set(
      orderIds.map((orderId) => {
        if (typeof orderId !== "string") {
          throw invalidRequest("Every order ID must be a string.");
        }
        return orderId.trim();
      })
    )
  );

  if (normalized.length > MAX_ORDER_IDS) {
    throw invalidRequest("Too many order IDs were requested.");
  }
  if (normalized.some((orderId) => !ORDER_ID.test(orderId))) {
    throw invalidRequest("One or more order IDs are invalid.");
  }

  return normalized;
}

function normalizeMessageIds(messageIds: string[]): string[] {
  if (!Array.isArray(messageIds)) {
    throw invalidRequest("Message IDs must be an array.");
  }

  const normalized = Array.from(new Set(messageIds));
  if (
    normalized.length > MAX_MESSAGE_IDS ||
    normalized.some(
      (messageId) => typeof messageId !== "string" || !HEX_64.test(messageId)
    )
  ) {
    throw invalidRequest("One or more message IDs are invalid.");
  }

  return normalized;
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

function serializeSignedEvent(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw invalidRequest("The signed request proof is invalid.");
  }

  if (
    !serialized ||
    serialized.length > MAX_PROOF_HEADER_LENGTH ||
    !isRecord(value)
  ) {
    throw invalidRequest("The signed request proof is invalid.");
  }

  return serialized;
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
  return `Seller orders request failed with status ${status}.`;
}

function parseStatuses(
  payload: unknown,
  requestedOrderIds: string[],
  status: number
): Partial<Record<string, SellerOrderStatus>> {
  if (!isRecord(payload) || !isRecord(payload.statuses)) {
    throw invalidResponse(status);
  }

  const requested = new Set(requestedOrderIds);
  const statuses: Partial<Record<string, SellerOrderStatus>> = {};
  for (const [orderId, orderStatus] of Object.entries(payload.statuses)) {
    if (
      !requested.has(orderId) ||
      typeof orderStatus !== "string" ||
      !STATUS_SET.has(orderStatus)
    ) {
      throw invalidResponse(status);
    }
    statuses[orderId] = orderStatus as SellerOrderStatus;
  }
  return statuses;
}

export function createSellerOrdersApiClient(
  options: CreateSellerOrdersApiClientOptions = {}
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
    } catch (error) {
      if (error instanceof SellerOrdersApiError) {
        throw error;
      }
      throw new SellerOrdersApiError(
        "Unable to reach the seller orders service.",
        0,
        "REQUEST_FAILED"
      );
    }

    let payload: unknown;
    try {
      const responseText = await response.text();
      payload = responseText
        ? (JSON.parse(responseText) as unknown)
        : undefined;
    } catch {
      throw invalidResponse(response.status);
    }

    if (!response.ok) {
      throw new SellerOrdersApiError(
        safeServerError(payload, response.status),
        response.status,
        "REQUEST_FAILED"
      );
    }

    return { payload, status: response.status };
  }

  return {
    async fetchSellerMessages(request: SellerMessagesRequest) {
      const sellerPubkey = request.sellerPubkey.trim().toLowerCase();
      if (!HEX_64.test(sellerPubkey)) {
        throw invalidRequest("A valid seller public key is required.");
      }
      const signedEvent = serializeSignedEvent(request.signedEvent);
      const query = new URLSearchParams({ pubkey: sellerPubkey });
      const headers = new Headers({
        Accept: "application/json",
        "x-signed-event": signedEvent,
      });
      const { payload, status } = await requestJson(
        `/api/db/fetch-messages?${query.toString()}`,
        { method: "GET", headers }
      );
      return parseCachedSellerMessages(payload, sellerPubkey, status);
    },

    async fetchOrderStatuses(request: FetchSellerOrderStatusesRequest) {
      const normalizedOrderIds = normalizeOrderIds(request.orderIds);
      if (normalizedOrderIds.length === 0) {
        return {} as Partial<Record<string, SellerOrderStatus>>;
      }
      const authorizationHeader = validateAuthorizationHeader(
        request.authorizationHeader
      );
      const headers = new Headers({
        Accept: "application/json",
        Authorization: authorizationHeader,
        "Content-Type": "application/json",
      });
      const { payload, status } = await requestJson(
        "/api/db/get-order-statuses",
        {
          method: "POST",
          headers,
          body: JSON.stringify({ orderIds: normalizedOrderIds }),
        }
      );
      return parseStatuses(payload, normalizedOrderIds, status);
    },

    async markMessagesRead(request: MarkSellerMessagesReadRequest) {
      const messageIds = normalizeMessageIds(request.messageIds);
      if (messageIds.length === 0) {
        return { success: true as const };
      }
      const authorizationHeader = validateAuthorizationHeader(
        request.authorizationHeader
      );
      const headers = new Headers({
        Accept: "application/json",
        Authorization: authorizationHeader,
        "Content-Type": "application/json",
      });
      const { payload, status } = await requestJson(
        "/api/db/mark-messages-read",
        {
          method: "POST",
          headers,
          body: JSON.stringify({ messageIds }),
        }
      );
      if (!isRecord(payload) || payload.success !== true) {
        throw invalidResponse(status);
      }
      return { success: true as const };
    },

    async updateOrderStatus(
      request: UpdateSellerOrderStatusRequest
    ): Promise<UpdateSellerOrderStatusResponse> {
      const orderId = request.orderId.trim();
      if (
        !ORDER_ID.test(orderId) ||
        !SELLER_STATUS_SET.has(request.status) ||
        EXPECTED_STATUS_BY_TARGET[request.status] !== request.expectedStatus
      ) {
        throw invalidRequest(
          "The requested seller order transition is invalid."
        );
      }
      if (!HEX_64.test(request.sellerPubkey)) {
        throw invalidRequest("The seller public key is invalid.");
      }
      if (request.buyerPubkey !== null && !HEX_64.test(request.buyerPubkey)) {
        throw invalidRequest("The buyer public key is invalid.");
      }
      if (request.messageId !== undefined && !HEX_64.test(request.messageId)) {
        throw invalidRequest("The source message ID is invalid.");
      }
      if (!TRANSITION_ID.test(request.transitionId)) {
        throw invalidRequest("The transition ID is invalid.");
      }
      const authorizationHeader = validateAuthorizationHeader(
        request.authorizationHeader
      );
      const body = {
        orderId,
        sellerPubkey: request.sellerPubkey,
        buyerPubkey: request.buyerPubkey,
        expectedStatus: request.expectedStatus,
        status: request.status,
        ...(request.messageId ? { messageId: request.messageId } : {}),
        transitionId: request.transitionId,
      };
      const headers = new Headers({
        Accept: "application/json",
        Authorization: authorizationHeader,
        "Content-Type": "application/json",
      });
      const { payload, status } = await requestJson(
        "/api/db/update-order-status",
        { method: "POST", headers, body: JSON.stringify(body) }
      );
      if (
        !isRecord(payload) ||
        payload.success !== true ||
        payload.orderId !== orderId ||
        payload.status !== request.status ||
        typeof payload.persisted !== "boolean" ||
        typeof payload.version !== "number" ||
        !Number.isSafeInteger(payload.version) ||
        payload.version < 1
      ) {
        throw invalidResponse(status);
      }
      return {
        success: true,
        orderId,
        status: request.status,
        persisted: payload.persisted,
        version: payload.version,
      };
    },
  };
}

export type SellerOrdersApiClient = ReturnType<
  typeof createSellerOrdersApiClient
>;
