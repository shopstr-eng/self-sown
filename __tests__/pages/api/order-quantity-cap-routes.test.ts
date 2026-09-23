/** @jest-environment node */

/**
 * Route-level pin for the server-side order-quantity cap.
 *
 * __tests__/utils/ucp/order-quantity-cap.test.ts proves createOrderFlow itself
 * throws OrderServiceError(400) for quantity > MAX_ORDER_QUANTITY. This file
 * proves the two REST entry points that funnel into createOrderFlow —
 * POST /api/mcp/create-order and POST /api/ucp/checkout/sessions — actually
 * surface that error as a 400 to HTTP callers. A route refactor that swallowed
 * or remapped the OrderServiceError (e.g. into a 500, or a UCP
 * requires_escalation envelope) would silently reopen the hole even with the
 * service guard in place.
 *
 * Unlike most route tests, @/utils/ucp/order-service is NOT mocked: the real
 * engine runs with only its DB/payment seams stubbed, so the cap genuinely
 * fires end-to-end (it rejects before any product lookup, so no DB fixture is
 * needed for the quantity path itself).
 */

import type { NextApiRequest, NextApiResponse } from "next";

const mockApplyRateLimit = jest.fn();
const mockAuthenticateRequest = jest.fn();
const mockInitializeApiKeysTable = jest.fn();
const mockResolveHostScope = jest.fn();
const mockFetchAllProductsFromDb = jest.fn();
const mockParseTags = jest.fn();
const mockInsertCheckoutSession = jest.fn();

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

// Seams of the REAL order engine (utils/ucp/order-service.ts). getDbPool is
// called at module scope by real utils/db/* modules; a mock without it kills
// the whole suite at import time.
jest.mock("@/utils/db/db-service", () => ({
  getDbPool: jest.fn(),
  fetchAllProductsFromDb: (...args: any[]) =>
    mockFetchAllProductsFromDb(...args),
  fetchAllProfilesFromDb: jest.fn(async () => []),
  getStripeConnectAccount: jest.fn(async () => null),
  validateDiscountCode: jest.fn(async () => ({ valid: false })),
  markDiscountCodeUsed: jest.fn(),
}));

jest.mock("@/utils/db/inventory-service", () => ({
  checkAvailability: jest.fn(async () => ({ tracked: false })),
  deductStock: jest.fn(),
}));

jest.mock("@/mcp/tools/purchase-tools", () => ({
  createMcpOrder: jest.fn(),
  updateMcpOrderPayment: jest.fn(),
  getMcpOrder: jest.fn(),
  listMcpOrders: jest.fn(),
  formatOrderForResponse: jest.fn((order: any) => order),
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
  formatCheckoutSession: jest.fn((row: any) => row),
  initCheckoutSessionsTable: jest.fn(() => Promise.resolve()),
  insertCheckoutSession: (...args: any[]) => mockInsertCheckoutSession(...args),
  listCheckoutSessions: jest.fn(),
  makeMessage: jest.fn((type: string, text: string, severity?: string) => ({
    type,
    text,
    severity,
  })),
}));

// Route handlers under test (imported AFTER the mocks above). order-service is
// pulled in really by these routes — never jest.mock'd here.
import createOrderHandler from "@/pages/api/mcp/create-order";
import checkoutSessionsHandler from "@/pages/api/ucp/checkout/sessions";
import { MAX_ORDER_QUANTITY } from "@/utils/ucp/order-limits";

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
  handler: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>,
  body: Record<string, unknown>
): Promise<ReturnType<typeof createResponse>> {
  const res = createResponse();
  await handler(createRequest(body), res as unknown as NextApiResponse);
  return res;
}

const CAP_MESSAGE = `quantity must not exceed ${MAX_ORDER_QUANTITY}`;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  mockApplyRateLimit.mockResolvedValue(true);
  mockInitializeApiKeysTable.mockResolvedValue(undefined);
  mockAuthenticateRequest.mockResolvedValue({ id: 1, pubkey: "buyer-pk" });
  // UCP route preamble: host scope + a product the seller owns.
  mockResolveHostScope.mockResolvedValue({ scope: "platform" });
  mockFetchAllProductsFromDb.mockResolvedValue([{ id: "p1" }]);
  mockParseTags.mockReturnValue({ pubkey: "seller-pk" });
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore?.();
});

describe("POST /api/mcp/create-order quantity cap", () => {
  it("returns 400 with the cap message for an absurd quantity", async () => {
    const res = await run(createOrderHandler, {
      productId: "p1",
      quantity: 1_000_000_000,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: CAP_MESSAGE });
  });

  it("returns 400 for a quantity just above the cap", async () => {
    const res = await run(createOrderHandler, {
      productId: "p1",
      quantity: MAX_ORDER_QUANTITY + 1,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({
      error: expect.stringMatching(/must not exceed/),
    });
  });
});

describe("POST /api/ucp/checkout/sessions quantity cap", () => {
  it("returns 400 with the cap message for an absurd quantity and persists no session", async () => {
    const res = await run(checkoutSessionsHandler, {
      productId: "p1",
      quantity: 1_000_000_000,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: CAP_MESSAGE });
    // The cap error is a validation failure, NOT a conversion failure: it must
    // not be remapped into a 200 requires_escalation envelope, and no junk
    // session row may be persisted.
    expect(mockInsertCheckoutSession).not.toHaveBeenCalled();
  });

  it("returns 400 for a quantity just above the cap", async () => {
    const res = await run(checkoutSessionsHandler, {
      productId: "p1",
      quantity: MAX_ORDER_QUANTITY + 1,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({
      error: expect.stringMatching(/must not exceed/),
    });
  });
});
