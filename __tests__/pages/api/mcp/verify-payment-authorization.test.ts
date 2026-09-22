/** @jest-environment node */

/**
 * Authorization pin for POST /api/mcp/verify-payment.
 *
 * Only the order's buyer may verify (or observe) payment status: a third
 * party's API key — including another seller's — must get a 403 before any
 * mint quote check or order mutation runs. The sibling GET
 * /api/mcp/create-order?orderId= gate is pinned separately in
 * get-order-authorization.test.ts.
 */

import type { NextApiRequest, NextApiResponse } from "next";

const mockApplyRateLimit = jest.fn();
const mockAuthenticateRequest = jest.fn();
const mockInitializeApiKeysTable = jest.fn();
const mockGetMcpOrder = jest.fn();
const mockUpdateMcpOrderPayment = jest.fn();

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: (...args: any[]) => mockApplyRateLimit(...args),
}));

jest.mock("@/utils/mcp/auth", () => ({
  authenticateRequest: (...args: any[]) => mockAuthenticateRequest(...args),
  initializeApiKeysTable: (...args: any[]) =>
    mockInitializeApiKeysTable(...args),
}));

jest.mock("@/utils/mcp/metrics", () => ({ recordRequest: jest.fn() }));

jest.mock("@/mcp/tools/purchase-tools", () => ({
  getMcpOrder: (...args: any[]) => mockGetMcpOrder(...args),
  updateMcpOrderPayment: (...args: any[]) =>
    mockUpdateMcpOrderPayment(...args),
}));

// verify-payment imports pendingLightningPayments from the sibling route;
// stub the module so this suite never pulls in the order-service graph.
jest.mock("@/pages/api/mcp/create-order", () => ({
  pendingLightningPayments: new Map(),
}));

jest.mock("@/utils/db/inventory-service", () => ({
  deductStock: jest.fn(),
}));

jest.mock("@/utils/db/db-service", () => ({
  markDiscountCodeUsed: jest.fn(),
  // getDbPool is called at module scope by real utils/db/* modules; a mock
  // without it kills the whole suite at import time.
  getDbPool: jest.fn(),
}));

jest.mock("@cashu/cashu-ts", () => ({
  Mint: jest.fn(),
  Wallet: jest.fn(),
  MintQuoteState: { UNPAID: "UNPAID", PAID: "PAID", ISSUED: "ISSUED" },
}));

import verifyPaymentHandler from "@/pages/api/mcp/verify-payment";

const BUYER_PK = "buyer-pk";
const SELLER_PK = "seller-pk";
const ORDER = {
  id: "order-1",
  order_id: "order-1",
  buyer_pubkey: BUYER_PK,
  seller_pubkey: SELLER_PK,
  payment_status: "paid",
  payment_intent_id: null,
};

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
  body: Record<string, unknown> = { orderId: "order-1" }
): Promise<ReturnType<typeof createResponse>> {
  mockAuthenticateRequest.mockResolvedValue({ id: 1, pubkey: callerPubkey });
  const res = createResponse();
  await verifyPaymentHandler(
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
  mockGetMcpOrder.mockResolvedValue(ORDER);
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore?.();
});

describe("POST /api/mcp/verify-payment authorization", () => {
  it("lets the buyer verify their own order", async () => {
    const res = await run(BUYER_PK);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true, status: "paid" });
  });

  it("returns 403 for a non-participant's pubkey before any mutation", async () => {
    const res = await run("stranger-pk");
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({
      error: "Not authorized to verify this order",
    });
    // No payment-state write may happen for a rejected caller.
    expect(mockUpdateMcpOrderPayment).not.toHaveBeenCalled();
  });

  it("returns 403 even for the seller's pubkey (verify is buyer-only)", async () => {
    const res = await run(SELLER_PK);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({
      error: "Not authorized to verify this order",
    });
    expect(mockUpdateMcpOrderPayment).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown orderId regardless of caller", async () => {
    mockGetMcpOrder.mockResolvedValue(null);
    const res = await run("stranger-pk");
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 when orderId is missing", async () => {
    const res = await run(BUYER_PK, {});
    expect(res.statusCode).toBe(400);
    expect(mockGetMcpOrder).not.toHaveBeenCalled();
  });
});
