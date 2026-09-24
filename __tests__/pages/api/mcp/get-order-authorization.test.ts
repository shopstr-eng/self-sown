/** @jest-environment node */

/**
 * Authorization pin for GET /api/mcp/create-order?orderId=... (the backing
 * route for the MCP get_order_status tool).
 *
 * The read is intentionally scoped to the order's participants: the buyer
 * (who placed it) and the seller (who fulfilled it) may view the order; any
 * third party's API key must still get a 403. The seller allowance exists so
 * sellers can check the status of a single order they sold — list_seller_orders
 * was previously their only option.
 */

import type { NextApiRequest, NextApiResponse } from "next";

const mockApplyRateLimit = jest.fn();
const mockAuthenticateRequest = jest.fn();
const mockInitializeApiKeysTable = jest.fn();
const mockGetMcpOrder = jest.fn();
const mockListMcpOrders = jest.fn();
const mockFormatOrderForResponse = jest.fn();

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
    createOrderFlow: jest.fn(),
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

const BUYER_PK = "buyer-pk";
const SELLER_PK = "seller-pk";
const ORDER = {
  id: "order-1",
  buyer_pubkey: BUYER_PK,
  seller_pubkey: SELLER_PK,
  status: "paid",
};

function createRequest(): NextApiRequest {
  return {
    method: "GET",
    headers: {},
    query: { orderId: "order-1" },
    body: {},
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
  callerPubkey: string
): Promise<ReturnType<typeof createResponse>> {
  mockAuthenticateRequest.mockResolvedValue({ id: 1, pubkey: callerPubkey });
  const res = createResponse();
  await createOrderHandler(
    createRequest(),
    res as unknown as NextApiResponse
  );
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  mockApplyRateLimit.mockResolvedValue(true);
  mockInitializeApiKeysTable.mockResolvedValue(undefined);
  mockGetMcpOrder.mockResolvedValue(ORDER);
  mockFormatOrderForResponse.mockImplementation((order: any) => ({
    id: order.id,
    status: order.status,
  }));
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore?.();
});

describe("GET /api/mcp/create-order?orderId= authorization", () => {
  it("lets the buyer view their order", async () => {
    const res = await run(BUYER_PK);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true });
  });

  it("lets the seller view an order they sold", async () => {
    const res = await run(SELLER_PK);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true });
  });

  it("still returns 403 for a third party's pubkey", async () => {
    const res = await run("stranger-pk");
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({
      error: "Not authorized to view this order",
    });
  });

  it("returns 404 when the order does not exist", async () => {
    mockGetMcpOrder.mockResolvedValue(null);
    const res = await run(SELLER_PK);
    expect(res.statusCode).toBe(404);
  });
});
