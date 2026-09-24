/** @jest-environment node */

/**
 * Guard for the "un-awaited helper returns escape try/catch" pattern.
 *
 * A Next.js API route that does `return handleX(...)` (no await) from its
 * outer handler lets any async throw inside the helper escape as an unhandled
 * rejection instead of the route's clean 500 JSON — the error mapping and
 * cleanup never run. This surfaced latently in
 * pages/api/stripe/create-cart-subscription.ts and the same shape existed in
 * the order/checkout routes pinned here.
 *
 * Note: broad coverage now comes from the type-aware ESLint rule
 * `@typescript-eslint/return-await` ("in-try-catch") in eslint.config.mjs,
 * which flags ANY `return promise` inside try/catch in pages/api regardless
 * of the callee's name. The name-based scan below remains as a fast,
 * lint-independent tripwire.
 *
 * Two layers:
 *  1. A source scan over pages/api forbidding bare `return handleX(...)`
 *     without `await` (the audit grep from .agents/memory/unawaited-helper-returns.md).
 *  2. Behavioral tests asserting the order/checkout/inventory routes answer a
 *     clean 500 JSON — and RESOLVE rather than reject — when a background
 *     step throws, including throws from code outside each helper's own
 *     internal try/catch.
 */

import * as fs from "fs";
import * as path from "path";
import type { NextApiRequest, NextApiResponse } from "next";

// ---------------------------------------------------------------------------
// Shared module mocks (one factory per module serves every route under test)
// ---------------------------------------------------------------------------

const mockApplyRateLimit = jest.fn();
const mockAuthenticateRequest = jest.fn();
const mockInitializeApiKeysTable = jest.fn();
const mockCreateOrderFlow = jest.fn();
const mockFormatOrderForResponse = jest.fn();
const mockGetMcpOrder = jest.fn();
const mockListMcpOrders = jest.fn();
const mockResolveHostScope = jest.fn();
const mockListCheckoutSessions = jest.fn();
const mockFetchAllProductsFromDb = jest.fn();
const mockParseTags = jest.fn();
const mockGetStock = jest.fn();
const mockCheckAvailability = jest.fn();

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

jest.mock("@/utils/ucp/seller-host", () => ({
  deriveBaseUrl: jest.fn(() => "https://platform.test"),
  resolveHostScope: (...args: any[]) => mockResolveHostScope(...args),
}));

jest.mock("@/utils/db/db-service", () => ({
  // getDbPool is called at module scope by real utils/db/* modules; a mock
  // without it kills the whole suite at import time.
  getDbPool: jest.fn(),
  fetchAllProductsFromDb: (...args: any[]) =>
    mockFetchAllProductsFromDb(...args),
  markDiscountCodeUsed: jest.fn(),
}));

jest.mock("@cashu/cashu-ts", () => ({
  Mint: jest.fn(),
  Wallet: jest.fn(),
  MintQuoteState: { UNPAID: "UNPAID", PAID: "PAID", ISSUED: "ISSUED" },
}));

jest.mock("@/utils/parsers/product-parser-functions", () => ({
  parseTags: (...args: any[]) => mockParseTags(...args),
}));

jest.mock("@/utils/ucp/checkout-store", () => ({
  decodeVariantId: jest.fn(() => ({ ok: false, error: "no variants in test" })),
  formatCheckoutSession: jest.fn((row: any) => row),
  initCheckoutSessionsTable: jest.fn(() => Promise.resolve()),
  insertCheckoutSession: jest.fn(),
  listCheckoutSessions: (...args: any[]) => mockListCheckoutSessions(...args),
  makeMessage: jest.fn((type: string, text: string, severity?: string) => ({
    type,
    text,
    severity,
  })),
}));

jest.mock("@/utils/db/inventory-service", () => ({
  getStock: (...args: any[]) => mockGetStock(...args),
  getAllStock: jest.fn(),
  setStock: jest.fn(),
  deductStock: jest.fn(),
  restoreStock: jest.fn(),
  checkAvailability: (...args: any[]) => mockCheckAvailability(...args),
  syncFromNostrEvent: jest.fn(),
}));

jest.mock("@/utils/nostr/nip98-auth", () => ({
  verifyNip98Request: jest.fn(),
}));

// Route handlers under test (imported AFTER the mocks above).
import createOrderHandler from "@/pages/api/mcp/create-order";
import checkoutSessionsHandler from "@/pages/api/ucp/checkout/sessions";
import inventoryHandler from "@/pages/api/inventory";
import verifyPaymentHandler from "@/pages/api/mcp/verify-payment";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

function createRequest(
  method: string,
  extras: Record<string, any> = {}
): NextApiRequest {
  return {
    method,
    headers: {},
    query: {},
    body: {},
    socket: { remoteAddress: "203.0.113.7" },
    ...extras,
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

type MockResponse = ReturnType<typeof createResponse>;

async function run(
  handler: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>,
  req: NextApiRequest
): Promise<MockResponse> {
  const res = createResponse();
  // If the route lets a helper rejection escape, this await THROWS and the
  // test fails — that is exactly the crash shape being guarded against.
  await handler(req, res as unknown as NextApiResponse);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  mockApplyRateLimit.mockResolvedValue(true);
  mockInitializeApiKeysTable.mockResolvedValue(undefined);
  mockAuthenticateRequest.mockResolvedValue({ id: 1, pubkey: "buyer-pk" });
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore?.();
});

// ---------------------------------------------------------------------------
// 1. Source-scan guard
// ---------------------------------------------------------------------------

describe("pages/api source scan", () => {
  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  it("has no bare `return handleX(...)` without await in pages/api", () => {
    const apiDir = path.join(__dirname, "..", "..", "..", "pages", "api");
    const offenders: string[] = [];
    for (const file of walk(apiDir)) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (/^\s*return\s+handle[A-Z]\w*\s*\(/.test(line)) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Behavioral clean-500 pins
// ---------------------------------------------------------------------------

describe("POST /api/mcp/create-order", () => {
  it("maps an order-engine throw to a clean 500 JSON", async () => {
    mockCreateOrderFlow.mockRejectedValue(new Error("db down"));
    const res = await run(
      createOrderHandler,
      createRequest("POST", { body: { productId: "p1" } })
    );
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ error: "Failed to create order" });
  });

  it("still answers a clean 500 when a throw escapes the helper's own try/catch", async () => {
    // createOrderFlow succeeds, but response formatting (called OUTSIDE
    // handleCreateOrder's try/catch) throws. Without `return await` +
    // outer try/catch in the route handler this rejects the request.
    mockCreateOrderFlow.mockResolvedValue({
      kind: "cashu",
      order: { order_id: "o1", amount_total: 100, currency: "usd" },
      tokenAmount: 5,
      requiredAmount: 5,
      change: [],
      pricingBlock: {},
    });
    mockFormatOrderForResponse.mockImplementation(() => {
      throw new Error("formatter blew up");
    });
    const res = await run(
      createOrderHandler,
      createRequest("POST", { body: { productId: "p1" } })
    );
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ error: "Internal server error" });
  });
});

describe("GET /api/mcp/create-order", () => {
  it("maps a list failure to a clean 500 JSON", async () => {
    mockListMcpOrders.mockRejectedValue(new Error("db down"));
    const res = await run(createOrderHandler, createRequest("GET"));
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ error: "Failed to list orders" });
  });
});

describe("POST /api/ucp/checkout/sessions", () => {
  it("answers a clean 500 when host-scope resolution throws outside any helper try/catch", async () => {
    mockResolveHostScope.mockRejectedValue(new Error("db down"));
    const res = await run(
      checkoutSessionsHandler,
      createRequest("POST", { body: { productId: "p1" } })
    );
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({
      error: "Failed to process checkout session request",
    });
  });

  it("maps an order-engine throw to a clean 500 JSON", async () => {
    mockResolveHostScope.mockResolvedValue({ scope: "platform" });
    mockFetchAllProductsFromDb.mockResolvedValue([{ id: "p1" }]);
    mockParseTags.mockReturnValue({ pubkey: "seller-pk" });
    mockCreateOrderFlow.mockRejectedValue(new Error("stripe down"));
    const res = await run(
      checkoutSessionsHandler,
      createRequest("POST", { body: { productId: "p1" } })
    );
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({
      error: "Failed to create checkout session",
    });
  });
});

describe("GET /api/ucp/checkout/sessions", () => {
  it("maps a session-list failure to a clean 500 JSON", async () => {
    mockListCheckoutSessions.mockRejectedValue(new Error("db down"));
    const res = await run(checkoutSessionsHandler, createRequest("GET"));
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({
      error: "Failed to list checkout sessions",
    });
  });
});

describe("preamble failures (table init / auth)", () => {
  // The routes memoize table init behind a module-level `tablesReady` flag, so
  // a rejection there is only reachable on a FRESH module instance — reset the
  // registry and re-import, or the flag from an earlier test skips the call.
  it("create-order resolves a clean 500 JSON when table init rejects", async () => {
    mockInitializeApiKeysTable.mockRejectedValueOnce(new Error("db down"));
    jest.resetModules();
    const { default: handler } = await import("@/pages/api/mcp/create-order");
    const res = await run(
      handler,
      createRequest("POST", { body: { productId: "p1" } })
    );
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ error: "Internal server error" });
  });

  it("create-order resolves a clean 500 JSON when auth rejects", async () => {
    mockAuthenticateRequest.mockRejectedValue(new Error("db down"));
    const res = await run(
      createOrderHandler,
      createRequest("POST", { body: { productId: "p1" } })
    );
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ error: "Internal server error" });
  });

  it("checkout sessions resolves a clean 500 JSON when table init rejects", async () => {
    mockInitializeApiKeysTable.mockRejectedValueOnce(new Error("db down"));
    jest.resetModules();
    const { default: handler } =
      await import("@/pages/api/ucp/checkout/sessions");
    const res = await run(
      handler,
      createRequest("POST", { body: { productId: "p1" } })
    );
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({
      error: "Failed to process checkout session request",
    });
  });

  it("checkout sessions resolves a clean 500 JSON when auth rejects", async () => {
    mockAuthenticateRequest.mockRejectedValue(new Error("db down"));
    const res = await run(
      checkoutSessionsHandler,
      createRequest("POST", { body: { productId: "p1" } })
    );
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({
      error: "Failed to process checkout session request",
    });
  });

  it("verify-payment resolves a clean 500 JSON when table init rejects", async () => {
    mockInitializeApiKeysTable.mockRejectedValueOnce(new Error("db down"));
    jest.resetModules();
    const { default: handler } = await import("@/pages/api/mcp/verify-payment");
    const res = await run(
      handler,
      createRequest("POST", { body: { orderId: "o1" } })
    );
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ error: "Failed to verify payment" });
  });

  it("verify-payment resolves a clean 500 JSON when auth rejects", async () => {
    mockAuthenticateRequest.mockRejectedValue(new Error("db down"));
    const res = await run(
      verifyPaymentHandler,
      createRequest("POST", { body: { orderId: "o1" } })
    );
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ error: "Failed to verify payment" });
  });
});

describe("/api/inventory", () => {
  it("GET maps a stock lookup failure to a clean 500 JSON", async () => {
    mockGetStock.mockRejectedValue(new Error("db down"));
    const res = await run(
      inventoryHandler,
      createRequest("GET", {
        query: { productId: "p1", variantKey: "size:1" },
      })
    );
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ error: "Failed to fetch inventory" });
  });

  it("POST answers a clean 500 when the rate-limit step throws outside the helper's try/catch", async () => {
    mockApplyRateLimit.mockRejectedValue(new Error("store down"));
    const res = await run(
      inventoryHandler,
      createRequest("POST", { body: { action: "check", productId: "p1" } })
    );
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({
      error: "Failed to process inventory request",
    });
  });
});
