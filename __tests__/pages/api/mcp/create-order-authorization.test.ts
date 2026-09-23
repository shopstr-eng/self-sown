/** @jest-environment node */

/**
 * Authorization pin for POST /api/mcp/create-order (the write path backing
 * the MCP create_order tool).
 *
 * The buyer identity for the created order comes from the authenticated API
 * key (apiKey.pubkey), never from the request body. A refactor that trusted a
 * body-supplied buyer identity would let one key holder place orders as
 * another buyer — wrong receipt emails, order history pollution. The sibling
 * read/verify gates are pinned in get-order-authorization.test.ts and
 * verify-payment-authorization.test.ts.
 */

import type { NextApiRequest, NextApiResponse } from "next";

const mockApplyRateLimit = jest.fn();
const mockAuthenticateRequest = jest.fn();
const mockInitializeApiKeysTable = jest.fn();
const mockGetMcpOrder = jest.fn();
const mockListMcpOrders = jest.fn();
const mockFormatOrderForResponse = jest.fn();
const mockCreateOrderFlow = jest.fn();

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: (...args: any[]) => mockApplyRateLimit(...args),
}));

jest.mock("@/utils/mcp/auth", () => ({
  authenticateRequest: (...args: any[]) => mockAuthenticateRequest(...args),
  initializeApiKeysTable: (...args: any[]) =>
    mockInitializeApiKeysTable(...args),
}));

jest.mock("@/utils/mcp/metrics", () => ({ recordRequest: jest.fn() }));

jest.mock("@/utils/l402", () => ({
  issueMacaroon: jest.fn(() => "macaroon"),
  setL402Challenge: jest.fn(),
  buildL402Body: jest.fn(() => ({})),
}));

jest.mock("@/mcp/tools/purchase-tools", () => ({
  getMcpOrder: (...args: any[]) => mockGetMcpOrder(...args),
  listMcpOrders: (...args: any[]) => mockListMcpOrders(...args),
  formatOrderForResponse: (...args: any[]) =>
    mockFormatOrderForResponse(...args),
}));

jest.mock("@/utils/ucp/order-service", () => {
  class OrderServiceError extends Error {
    status: number;
    body: Record<string, any>;
    constructor(status: number, body: Record<string, any>) {
      super(typeof body?.error === "string" ? body.error : "order error");
      this.status = status;
      this.body = body;
    }
  }
  return {
    __esModule: true,
    OrderServiceError,
    createOrderFlow: (...args: any[]) => mockCreateOrderFlow(...args),
    pendingLightningPayments: new Map(),
  };
});

jest.mock("@/utils/db/db-service", () => ({
  // getDbPool is called at module scope by real utils/db/* modules; a mock
  // without it kills the whole suite at import time.
  getDbPool: jest.fn(),
}));

jest.mock("@cashu/cashu-ts", () => ({
  Mint: jest.fn(),
  Wallet: jest.fn(),
  MintQuoteState: { UNPAID: "UNPAID", PAID: "PAID", ISSUED: "ISSUED" },
}));

import createOrderHandler from "@/pages/api/mcp/create-order";

const CALLER_PK = "caller-pk";
const OTHER_PK = "other-buyer-pk";

function createRequest(body: Record<string, unknown>): NextApiRequest {
  return {
    method: "POST",
    headers: {},
    query: {},
    body,
    socket: { remoteAddress: "203.0.113.7" },
  } as unknown as NextApiRequest;
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    send(payload: unknown) {
      this.body = payload;
      return this;
    },
    end() {
      return this;
    },
    setHeader(key: string, value: string) {
      this.headers[key] = value;
      return this;
    },
    getHeader(key: string) {
      return this.headers[key];
    },
  };
}

async function run(
  callerPubkey: string,
  body: Record<string, unknown>
): Promise<ReturnType<typeof createResponse>> {
  mockAuthenticateRequest.mockResolvedValue({ id: 7, pubkey: callerPubkey });
  const res = createResponse();
  await createOrderHandler(
    createRequest(body),
    res as unknown as NextApiResponse
  );
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  mockApplyRateLimit.mockResolvedValue(true);
  mockInitializeApiKeysTable.mockResolvedValue(undefined);
  mockFormatOrderForResponse.mockImplementation((order: any) => ({
    id: order.id,
  }));
  // A minimal stripe-kind result so the route completes with a 402 payment
  // challenge and never touches the L402 or Cashu branches.
  mockCreateOrderFlow.mockResolvedValue({
    kind: "stripe",
    order: { id: "order-1", order_id: "order-1" },
    amount: 1000,
    currency: "usd",
    paymentIntentId: "pi_1",
    clientSecret: "cs_1",
    pricingBlock: {},
  });
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore?.();
});

describe("POST /api/mcp/create-order buyer identity binding", () => {
  it("uses the API key's pubkey as buyerPubkey on a clean request", async () => {
    const res = await run(CALLER_PK, { productId: "product-1" });
    expect(res.statusCode).toBe(402);
    expect(mockCreateOrderFlow).toHaveBeenCalledTimes(1);
    expect(mockCreateOrderFlow.mock.calls[0][0]).toMatchObject({
      buyerPubkey: CALLER_PK,
      apiKeyId: 7,
    });
  });

  it("ignores a conflicting buyerPubkey field in the request body", async () => {
    const res = await run(CALLER_PK, {
      productId: "product-1",
      buyerPubkey: OTHER_PK,
    });
    expect(res.statusCode).toBe(402);
    expect(mockCreateOrderFlow).toHaveBeenCalledTimes(1);
    expect(mockCreateOrderFlow.mock.calls[0][0].buyerPubkey).toBe(CALLER_PK);
  });

  it("ignores snake_case / alternate buyer identity fields in the body", async () => {
    const res = await run(CALLER_PK, {
      productId: "product-1",
      buyer_pubkey: OTHER_PK,
      buyerNpub: "npub1other",
      npub: "npub1other",
      buyer: OTHER_PK,
      pubkey: OTHER_PK,
    });
    expect(res.statusCode).toBe(402);
    expect(mockCreateOrderFlow).toHaveBeenCalledTimes(1);
    const input = mockCreateOrderFlow.mock.calls[0][0];
    expect(input.buyerPubkey).toBe(CALLER_PK);
    // None of the smuggled identities may appear anywhere in the flow input.
    expect(Object.values(input)).not.toContain(OTHER_PK);
    expect(Object.values(input)).not.toContain("npub1other");
  });

  it("does not invoke createOrderFlow for an unauthenticated request", async () => {
    mockAuthenticateRequest.mockResolvedValue(null);
    const res = createResponse();
    await createOrderHandler(
      createRequest({ productId: "product-1" }),
      res as unknown as NextApiResponse
    );
    expect(mockCreateOrderFlow).not.toHaveBeenCalled();
  });
});
