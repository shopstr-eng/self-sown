/** @jest-environment node */

/**
 * Route-level pin for the quantity type guard on POST /api/ucp/checkout/sessions.
 *
 * The route previously coerced any non-number quantity to 1
 * (`typeof body.quantity === "number" ? body.quantity : 1`), so a UCP client
 * that sent "5" (string), "5.0", or another JSON type was silently charged and
 * delivered exactly 1 item with no error. The sibling MCP route passes the
 * value through to the order engine, which rejects it — the two endpoints
 * disagreed on malformed input.
 *
 * Here the order engine IS mocked (unlike order-quantity-cap-routes.test.ts,
 * which proves the engine's own cap fires end-to-end): these tests isolate the
 * route's request-shape validation, which runs before the engine is invoked.
 */

import type { NextApiRequest, NextApiResponse } from "next";

const mockApplyRateLimit = jest.fn();
const mockAuthenticateRequest = jest.fn();
const mockInitializeApiKeysTable = jest.fn();
const mockResolveHostScope = jest.fn();
const mockFetchAllProductsFromDb = jest.fn();
const mockParseTags = jest.fn();
const mockInsertCheckoutSession = jest.fn();
const mockCreateOrderFlow = jest.fn();

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: (...args: any[]) => mockApplyRateLimit(...args),
}));

jest.mock("@/utils/mcp/auth", () => ({
  authenticateRequest: (...args: any[]) => mockAuthenticateRequest(...args),
  initializeApiKeysTable: (...args: any[]) =>
    mockInitializeApiKeysTable(...args),
}));

// db-service mock needs getDbPool: real utils/db/* modules call it at module
// scope, and a mock without it kills the whole suite at import time.
jest.mock("@/utils/db/db-service", () => ({
  getDbPool: jest.fn(),
  fetchAllProductsFromDb: (...args: any[]) =>
    mockFetchAllProductsFromDb(...args),
}));

jest.mock("@/utils/parsers/product-parser-functions", () => ({
  parseTags: (...args: any[]) => mockParseTags(...args),
}));

jest.mock("@/utils/ucp/seller-host", () => ({
  deriveBaseUrl: jest.fn(() => "https://platform.test"),
  resolveHostScope: (...args: any[]) => mockResolveHostScope(...args),
}));

jest.mock("@/utils/ucp/checkout-store", () => ({
  decodeVariantId: jest.fn(() => ({ ok: false, error: "no variants in test" })),
  // describeResult moved into checkout-store (shared by create + retry); the
  // route imports it from here, so the mock must provide the real one.
  describeResult: jest.requireActual("@/utils/ucp/checkout-store")
    .describeResult,
  formatCheckoutSession: jest.fn((row: any) => row),
  formatEphemeralCheckoutSession: jest.fn((input: any) => input),
  generateCheckoutSessionId: jest.fn(() => "ucp_cs_test"),
  initCheckoutSessionsTable: jest.fn(() => Promise.resolve()),
  insertCheckoutSession: (...args: any[]) => mockInsertCheckoutSession(...args),
  listCheckoutSessions: jest.fn(),
  makeMessage: jest.fn((type: string, text: string, severity?: string) => ({
    type,
    text,
    severity,
  })),
}));

jest.mock("@/utils/ucp/order-service", () => ({
  createOrderFlow: (...args: any[]) => mockCreateOrderFlow(...args),
  OrderServiceError: class OrderServiceError extends Error {
    status: number;
    body: any;
    constructor(status: number, body: any) {
      super(body?.error ?? "order service error");
      this.status = status;
      this.body = body;
    }
  },
}));

// Route handler under test (imported AFTER the mocks above).
import checkoutSessionsHandler from "@/pages/api/ucp/checkout/sessions";

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
  body: Record<string, unknown>
): Promise<ReturnType<typeof createResponse>> {
  const res = createResponse();
  await checkoutSessionsHandler(
    createRequest(body),
    res as unknown as NextApiResponse
  );
  return res;
}

const stripeResult = {
  kind: "stripe" as const,
  order: { order_id: "ord_1", amount_total: 3000, currency: "usd" },
  amount: 3000,
  currency: "usd",
  paymentIntentId: "pi_1",
  clientSecret: "secret_1",
  connectedAccountId: "acct_1",
  pricingBlock: { subtotal: 3000 },
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  mockApplyRateLimit.mockResolvedValue(true);
  mockInitializeApiKeysTable.mockResolvedValue(undefined);
  mockAuthenticateRequest.mockResolvedValue({ id: 1, pubkey: "buyer-pk" });
  mockResolveHostScope.mockResolvedValue({ scope: "platform" });
  mockFetchAllProductsFromDb.mockResolvedValue([{ id: "p1" }]);
  mockParseTags.mockReturnValue({ pubkey: "seller-pk" });
  mockInsertCheckoutSession.mockImplementation(async (row: any) => row);
  mockCreateOrderFlow.mockResolvedValue(stripeResult);
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore?.();
});

describe("POST /api/ucp/checkout/sessions quantity type guard", () => {
  it.each([
    ["an integer-as-string", "5"],
    ["a float-as-string", "5.0"],
    ["a numeric-looking string with whitespace", " 3 "],
    ["an explicit null", null],
    ["an array", [5]],
    ["an object", { value: 5 }],
    ["a boolean", true],
  ])(
    "returns 400 naming quantity for %s and never reaches the order engine",
    async (_label, quantity) => {
      const res = await run({ productId: "p1", quantity });
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({
        error: expect.stringMatching(/quantity must be a number/),
      });
      expect(mockCreateOrderFlow).not.toHaveBeenCalled();
      expect(mockInsertCheckoutSession).not.toHaveBeenCalled();
    }
  );

  it("passes a valid numeric quantity through to the order engine", async () => {
    const res = await run({ productId: "p1", quantity: 3 });
    expect(res.statusCode).toBe(201);
    expect(mockCreateOrderFlow).toHaveBeenCalledWith(
      expect.objectContaining({ productId: "p1", quantity: 3 })
    );
  });

  it("defaults an omitted quantity to 1", async () => {
    const res = await run({ productId: "p1" });
    expect(res.statusCode).toBe(201);
    expect(mockCreateOrderFlow).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: 1 })
    );
  });
});
