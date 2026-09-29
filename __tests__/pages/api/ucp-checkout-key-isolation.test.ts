/** @jest-environment node */

/**
 * Handler-level key isolation for saved checkout sessions.
 *
 * Companion to __tests__/utils/ucp/checkout-key-isolation.test.ts (SQL
 * contract): these tests drive the actual route handlers and pin the
 * security boundary — a session created by one API key is invisible to
 * EVERY other key on the same account, across list, read, and complete.
 * Same 404 as a missing session, so sessions can't be enumerated.
 */

import type { NextApiRequest, NextApiResponse } from "next";

const mockApplyRateLimit = jest.fn(async (..._args: any[]) => true);
const mockAuthenticateRequest = jest.fn();
const mockGetCheckoutSession = jest.fn();
const mockListCheckoutSessions = jest.fn();
const mockGetMcpOrder = jest.fn();

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: (...args: any[]) => mockApplyRateLimit(...args),
}));

jest.mock("@/utils/mcp/auth", () => ({
  authenticateRequest: (...args: any[]) => mockAuthenticateRequest(...args),
  initializeApiKeysTable: jest.fn(async () => undefined),
}));

// Real module for formatters/status helpers; DB-touching functions mocked.
jest.mock("@/utils/ucp/checkout-store", () => {
  const actual = jest.requireActual("@/utils/ucp/checkout-store");
  return {
    ...actual,
    initCheckoutSessionsTable: jest.fn(async () => undefined),
    maybePruneExpiredCheckoutEscalations: jest.fn(),
    getCheckoutSession: (...args: any[]) => mockGetCheckoutSession(...args),
    listCheckoutSessions: (...args: any[]) => mockListCheckoutSessions(...args),
  };
});

jest.mock("@/mcp/tools/purchase-tools", () => ({
  getMcpOrder: (...args: any[]) => mockGetMcpOrder(...args),
}));

jest.mock("@/utils/db/db-service", () => ({
  getDbPool: jest.fn(),
  fetchAllProductsFromDb: jest.fn(async () => []),
}));

jest.mock("@/utils/parsers/product-parser-functions", () => ({
  parseTags: jest.fn(() => ({})),
}));

jest.mock("@/utils/ucp/seller-host", () => ({
  deriveBaseUrl: jest.fn(() => "https://self-sown.com"),
  resolveHostScope: jest.fn(async () => ({ scope: "marketplace" })),
}));

jest.mock("@/utils/ucp/order-service", () => ({
  createOrderFlow: jest.fn(),
  OrderServiceError: class OrderServiceError extends Error {},
  VALID_METHODS: ["stripe", "lightning", "cashu", "fiat"],
}));

import sessionsHandler from "@/pages/api/ucp/checkout/sessions";
import sessionByIdHandler from "@/pages/api/ucp/checkout/sessions/[id]";
import completeHandler from "@/pages/api/ucp/checkout/sessions/[id]/complete";

// The authenticated key: id 1 on account buyer-pk.
const KEY = { id: 1, pubkey: "buyer-pk" };

// A session created by a DIFFERENT key (id 2) on the SAME account.
const OTHER_KEY_ROW = {
  id: "ucp_cs_other",
  api_key_id: 2,
  buyer_pubkey: "buyer-pk",
  seller_pubkey: "seller-pk",
  product_id: "product-1",
  mcp_order_id: null,
  status: "incomplete",
  payment_method: "stripe",
  amount_total: 10,
  currency: "usd",
  request: null,
  quote: null,
  payment: null,
  messages: [],
  error: null,
  code: null,
  created_at: new Date("2026-09-28T00:00:00Z"),
  updated_at: new Date("2026-09-28T00:00:00Z"),
};

function createResponse() {
  const res: any = {
    statusCode: 200,
    body: undefined as any,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
    end() {
      return this;
    },
  };
  return res as NextApiResponse & { statusCode: number; body: any };
}

function req(method: string, query: Record<string, any> = {}) {
  return { method, query, headers: {} } as unknown as NextApiRequest;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockApplyRateLimit.mockResolvedValue(true);
  mockAuthenticateRequest.mockResolvedValue(KEY);
});

describe("GET /api/ucp/checkout/sessions (list)", () => {
  it("passes the authenticated key id to the store query", async () => {
    mockListCheckoutSessions.mockResolvedValue([]);
    const res = createResponse();

    await sessionsHandler(req("GET"), res);

    expect(res.statusCode).toBe(200);
    // (buyerPubkey, apiKeyId, limit+1, offset) — key-private filter.
    expect(mockListCheckoutSessions).toHaveBeenCalledWith(
      "buyer-pk",
      1,
      expect.any(Number),
      0
    );
  });
});

describe("GET /api/ucp/checkout/sessions/[id]", () => {
  it("404s a session created by another key on the SAME account", async () => {
    mockGetCheckoutSession.mockResolvedValue(OTHER_KEY_ROW);
    const res = createResponse();

    await sessionByIdHandler(req("GET", { id: OTHER_KEY_ROW.id }), res);

    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    // Reconciliation must never run on a session we don't own.
    expect(mockGetMcpOrder).not.toHaveBeenCalled();
  });

  it("404s a legacy session with NULL api_key_id (fail closed)", async () => {
    mockGetCheckoutSession.mockResolvedValue({
      ...OTHER_KEY_ROW,
      api_key_id: null,
    });
    const res = createResponse();

    await sessionByIdHandler(req("GET", { id: OTHER_KEY_ROW.id }), res);

    expect(res.statusCode).toBe(404);
  });

  it("returns the session to the key that created it", async () => {
    mockGetCheckoutSession.mockResolvedValue({
      ...OTHER_KEY_ROW,
      api_key_id: 1,
      status: "completed",
    });
    const res = createResponse();

    await sessionByIdHandler(req("GET", { id: OTHER_KEY_ROW.id }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBe(OTHER_KEY_ROW.id);
  });
});

describe("POST /api/ucp/checkout/sessions/[id]/complete", () => {
  it("404s a session created by another key on the SAME account", async () => {
    mockGetCheckoutSession.mockResolvedValue(OTHER_KEY_ROW);
    const res = createResponse();

    await completeHandler(req("POST", { id: OTHER_KEY_ROW.id }), res);

    expect(res.statusCode).toBe(404);
    expect(mockGetMcpOrder).not.toHaveBeenCalled();
  });

  it("404s a legacy session with NULL api_key_id (fail closed)", async () => {
    mockGetCheckoutSession.mockResolvedValue({
      ...OTHER_KEY_ROW,
      api_key_id: null,
    });
    const res = createResponse();

    await completeHandler(req("POST", { id: OTHER_KEY_ROW.id }), res);

    expect(res.statusCode).toBe(404);
  });
});
