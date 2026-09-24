/** @jest-environment node */

/**
 * Authorization pin for GET /api/mcp/create-order in LIST mode (no orderId
 * query param) — the route backing an agent's order history.
 *
 * The buyer identity for the listing comes from the authenticated API key
 * (apiKey.pubkey), never from query parameters. A refactor that trusted a
 * caller-supplied ?buyer_pubkey=/pubkey= field would let one key holder read
 * another buyer's full order history — addresses, emails, purchase patterns.
 * The sibling gates are pinned in create-order-authorization.test.ts (write
 * path) and get-order-authorization.test.ts (single-order read).
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

const CALLER_PK = "caller-pk";
const OTHER_PK = "other-buyer-pk";

function createRequest(query: Record<string, unknown>): NextApiRequest {
  return {
    method: "GET",
    headers: {},
    query,
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
  callerPubkey: string,
  query: Record<string, unknown>
): Promise<ReturnType<typeof createResponse>> {
  mockAuthenticateRequest.mockResolvedValue({ id: 7, pubkey: callerPubkey });
  const res = createResponse();
  await createOrderHandler(
    createRequest(query),
    res as unknown as NextApiResponse
  );
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  mockApplyRateLimit.mockResolvedValue(true);
  mockInitializeApiKeysTable.mockResolvedValue(undefined);
  mockListMcpOrders.mockResolvedValue([{ id: "order-1" }]);
  mockFormatOrderForResponse.mockImplementation((order: any) => ({
    id: order.id,
  }));
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore?.();
});

describe("GET /api/mcp/create-order list-mode buyer identity binding", () => {
  it("lists orders for the API key's pubkey on a clean request", async () => {
    const res = await run(CALLER_PK, {});
    expect(res.statusCode).toBe(200);
    expect(mockListMcpOrders).toHaveBeenCalledTimes(1);
    expect(mockListMcpOrders.mock.calls[0][0]).toBe(CALLER_PK);
    expect((res.body as any).orders).toEqual([{ id: "order-1" }]);
  });

  it("ignores a conflicting buyer_pubkey query parameter", async () => {
    const res = await run(CALLER_PK, { buyer_pubkey: OTHER_PK });
    expect(res.statusCode).toBe(200);
    expect(mockListMcpOrders).toHaveBeenCalledTimes(1);
    expect(mockListMcpOrders.mock.calls[0][0]).toBe(CALLER_PK);
  });

  it("ignores camelCase / alternate buyer identity query parameters", async () => {
    const res = await run(CALLER_PK, {
      buyerPubkey: OTHER_PK,
      pubkey: OTHER_PK,
      buyer: OTHER_PK,
      npub: "npub1other",
      buyerNpub: "npub1other",
    });
    expect(res.statusCode).toBe(200);
    expect(mockListMcpOrders).toHaveBeenCalledTimes(1);
    // First arg (buyer identity) must be the key's pubkey; the smuggled
    // identities must not appear in ANY argument passed to the list query.
    const args = mockListMcpOrders.mock.calls[0];
    expect(args[0]).toBe(CALLER_PK);
    expect(args).not.toContain(OTHER_PK);
    expect(args).not.toContain("npub1other");
  });

  it("passes pagination through but never the identity", async () => {
    const res = await run(CALLER_PK, {
      buyer_pubkey: OTHER_PK,
      limit: "10",
      offset: "5",
    });
    expect(res.statusCode).toBe(200);
    expect(mockListMcpOrders).toHaveBeenCalledTimes(1);
    expect(mockListMcpOrders.mock.calls[0]).toEqual([CALLER_PK, 10, 5]);
    expect((res.body as any).pagination).toEqual({
      limit: 10,
      offset: 5,
      count: 1,
    });
  });

  it("clamps malformed pagination instead of 500ing (?limit=abc)", async () => {
    const res = await run(CALLER_PK, { limit: "abc" });
    expect(res.statusCode).toBe(200);
    // NaN must never reach the SQL placeholders — fall back to the default.
    expect(mockListMcpOrders.mock.calls[0]).toEqual([CALLER_PK, 50, 0]);
    expect((res.body as any).pagination).toEqual({
      limit: 50,
      offset: 0,
      count: 1,
    });
  });

  it("clamps a negative offset to 0 (?offset=-1)", async () => {
    const res = await run(CALLER_PK, { offset: "-1" });
    expect(res.statusCode).toBe(200);
    expect(mockListMcpOrders.mock.calls[0]).toEqual([CALLER_PK, 50, 0]);
    expect((res.body as any).pagination.offset).toBe(0);
  });

  it("clamps out-of-range values into 1-100 limit / non-negative offset", async () => {
    const res = await run(CALLER_PK, { limit: "500", offset: "abc" });
    expect(res.statusCode).toBe(200);
    expect(mockListMcpOrders.mock.calls[0]).toEqual([CALLER_PK, 100, 0]);
    expect((res.body as any).pagination).toEqual({
      limit: 100,
      offset: 0,
      count: 1,
    });

    const res2 = await run(CALLER_PK, { limit: "0" });
    expect(res2.statusCode).toBe(200);
    expect(mockListMcpOrders.mock.calls[1]).toEqual([CALLER_PK, 1, 0]);
  });

  it("does not invoke listMcpOrders for an unauthenticated request", async () => {
    mockAuthenticateRequest.mockResolvedValue(null);
    const res = createResponse();
    await createOrderHandler(
      createRequest({ buyer_pubkey: OTHER_PK }),
      res as unknown as NextApiResponse
    );
    expect(mockListMcpOrders).not.toHaveBeenCalled();
  });
});
