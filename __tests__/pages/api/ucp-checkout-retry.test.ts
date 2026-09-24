/** @jest-environment node */

/**
 * POST /api/ucp/checkout/sessions/[id]/retry — resume a pre-order
 * requires_escalation session with a different payment method.
 *
 * The REAL order engine (utils/ucp/order-service.ts) runs, as in
 * ucp-checkout-schema-parity.test.ts — only its DB/payment seams are stubbed,
 * and STRIPE_SECRET_KEY is unset so the Stripe branch is skipped. The store's
 * retry primitives (claim/resolve/fail) are mocked at the module boundary;
 * the formatters + describeResult stay real so responses keep the published
 * session shape (one case validates against the live schema endpoint).
 */

import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { NextApiRequest, NextApiResponse } from "next";

const mockApplyRateLimit = jest.fn();
const mockAuthenticateRequest = jest.fn();
const mockInitializeApiKeysTable = jest.fn();
const mockResolveHostScope = jest.fn();
const mockFetchAllProductsFromDb = jest.fn();
const mockFetchAllProfilesFromDb = jest.fn();
const mockParseTags = jest.fn();
const mockCreateMcpOrder = jest.fn();
const mockGetCheckoutSession = jest.fn();
const mockClaimCheckoutSessionRetry = jest.fn();
const mockResolveCheckoutSessionRetry = jest.fn();
const mockFailCheckoutSessionRetry = jest.fn();
const mockRescueCheckoutSessionRetry = jest.fn();

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: (...args: any[]) => mockApplyRateLimit(...args),
}));

jest.mock("@/utils/mcp/auth", () => ({
  authenticateRequest: (...args: any[]) => mockAuthenticateRequest(...args),
  initializeApiKeysTable: (...args: any[]) =>
    mockInitializeApiKeysTable(...args),
}));

// Seams of the REAL order engine. getDbPool is called at module scope by real
// utils/db/* modules; a mock without it kills the whole suite at import time.
jest.mock("@/utils/db/db-service", () => ({
  getDbPool: jest.fn(),
  fetchAllProductsFromDb: (...args: any[]) =>
    mockFetchAllProductsFromDb(...args),
  fetchAllProfilesFromDb: (...args: any[]) =>
    mockFetchAllProfilesFromDb(...args),
  getStripeConnectAccount: jest.fn(async () => null),
  validateDiscountCode: jest.fn(async () => ({ valid: false })),
  markDiscountCodeUsed: jest.fn(),
}));

jest.mock("@/utils/db/inventory-service", () => ({
  checkAvailability: jest.fn(async () => ({ tracked: false })),
  deductStock: jest.fn(),
}));

jest.mock("@/mcp/tools/purchase-tools", () => ({
  createMcpOrder: (...args: any[]) => mockCreateMcpOrder(...args),
  updateMcpOrderPayment: jest.fn(),
}));

jest.mock("@/utils/parsers/product-parser-functions", () => ({
  parseTags: (...args: any[]) => mockParseTags(...args),
}));

jest.mock("@/utils/ucp/seller-host", () => ({
  deriveBaseUrl: jest.fn(() => "https://platform.test"),
  resolveHostScope: (...args: any[]) => mockResolveHostScope(...args),
}));

jest.mock("@/utils/ucp/checkout-store", () => {
  // Formatters, describeResult, and makeMessage stay REAL so the responses
  // below are the production session shape; only the DB-touching pieces are
  // stubbed.
  const actual = jest.requireActual("@/utils/ucp/checkout-store");
  return {
    ...actual,
    initCheckoutSessionsTable: jest.fn(() => Promise.resolve()),
    getCheckoutSession: (...args: any[]) => mockGetCheckoutSession(...args),
    claimCheckoutSessionRetry: (...args: any[]) =>
      mockClaimCheckoutSessionRetry(...args),
    resolveCheckoutSessionRetry: (...args: any[]) =>
      mockResolveCheckoutSessionRetry(...args),
    failCheckoutSessionRetry: (...args: any[]) =>
      mockFailCheckoutSessionRetry(...args),
    rescueCheckoutSessionRetry: (...args: any[]) =>
      mockRescueCheckoutSessionRetry(...args),
  };
});

// Handlers under test (imported AFTER the mocks above).
import retryHandler from "@/pages/api/ucp/checkout/sessions/[id]/retry";
import checkoutSessionSchemaHandler from "@/pages/api/ucp/schemas/checkout-session.json";

const ISO = new Date(1_700_000_000_000).toISOString();

/** A persisted PRE-ORDER escalation: sats attempted on a USD product. */
const escalatedRow = {
  id: "ucp_cs_retry_1",
  api_key_id: 1,
  buyer_pubkey: "buyer-pk",
  seller_pubkey: "seller-pk",
  product_id: "p1",
  mcp_order_id: null,
  status: "requires_escalation",
  payment_method: "lightning",
  amount_total: "0",
  currency: "usd",
  request: { productId: "p1", quantity: 2, paymentMethod: "lightning" },
  quote: null,
  payment: null,
  messages: [
    {
      type: "session_created",
      text: "Checkout session created.",
      at: ISO,
    },
    {
      type: "requires_escalation",
      text: "This product is priced in USD and can't be settled in Bitcoin…",
      at: ISO,
      severity: "error",
    },
  ],
  error: "This product is priced in USD and can't be settled in Bitcoin…",
  code: "exchange_rate_unavailable",
  created_at: ISO,
  updated_at: ISO,
};

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
    end() {
      return this;
    },
    setHeader(key: string, value: string) {
      this.headers[key] = value;
      return this;
    },
  };
}

async function postRetry(
  id: string,
  body: Record<string, unknown>
): Promise<ReturnType<typeof createResponse>> {
  const res = createResponse();
  await retryHandler(
    {
      method: "POST",
      headers: {},
      query: { id },
      body,
      socket: { remoteAddress: "203.0.113.9" },
    } as unknown as NextApiRequest,
    res as unknown as NextApiResponse
  );
  return res;
}

let savedStripeSecretKey: string | undefined;

beforeAll(() => {
  savedStripeSecretKey = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
});

afterAll(() => {
  if (savedStripeSecretKey !== undefined) {
    process.env.STRIPE_SECRET_KEY = savedStripeSecretKey;
  }
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  mockApplyRateLimit.mockResolvedValue(true);
  mockInitializeApiKeysTable.mockResolvedValue(undefined);
  mockAuthenticateRequest.mockResolvedValue({ id: 1, pubkey: "buyer-pk" });
  mockResolveHostScope.mockResolvedValue({ scope: "platform" });
  mockFetchAllProductsFromDb.mockResolvedValue([{ id: "p1" }]);
  // Seller profile with a fiat rail so a fiat retry completes the real
  // engine's fiat branch without a network call.
  mockFetchAllProfilesFromDb.mockResolvedValue([
    {
      pubkey: "seller-pk",
      kind: 0,
      created_at: 1,
      content: JSON.stringify({ fiat_options: ["cash"] }),
    },
  ]);
  mockParseTags.mockReturnValue({
    pubkey: "seller-pk",
    title: "Test Product",
    price: 30,
    currency: "USD",
  });
  mockCreateMcpOrder.mockResolvedValue({
    order_id: "ord_retry_1",
    amount_total: 6000,
    currency: "USD",
  });
  mockGetCheckoutSession.mockResolvedValue(escalatedRow);
  // The claim flips status to 'incomplete' and returns the claimed row.
  mockClaimCheckoutSessionRetry.mockImplementation(async () => ({
    ...escalatedRow,
    status: "incomplete",
  }));
  mockResolveCheckoutSessionRetry.mockImplementation(
    async (_id: string, input: any) => ({
      ...escalatedRow,
      status: input.status,
      messages: input.messages,
      payment: input.payment,
      quote: input.quote,
      mcp_order_id: input.mcpOrderId,
      amount_total: String(input.amountTotal),
      currency: input.currency,
      payment_method: input.paymentMethod,
      error: null,
      code: null,
    })
  );
  mockFailCheckoutSessionRetry.mockImplementation(
    async (_id: string, messages: any, error: any, code: any, method: any) => ({
      ...escalatedRow,
      status: "requires_escalation",
      messages,
      error,
      code,
      payment_method: method,
    })
  );
  // The rescue write is STATUS-PRESERVING: the row stays claimed
  // ('incomplete') and gains whatever the input attaches.
  mockRescueCheckoutSessionRetry.mockImplementation(
    async (_id: string, input: any) => ({
      ...escalatedRow,
      status: "incomplete",
      mcp_order_id: input.mcpOrderId ?? escalatedRow.mcp_order_id,
      payment: input.payment ?? escalatedRow.payment,
      quote: input.quote ?? escalatedRow.quote,
      amount_total:
        input.amountTotal != null
          ? String(input.amountTotal)
          : escalatedRow.amount_total,
      currency: input.currency ?? escalatedRow.currency,
      payment_method: input.paymentMethod ?? escalatedRow.payment_method,
      messages: input.messages,
      error: input.error,
      code: input.code,
    })
  );
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore?.();
});

describe("POST /api/ucp/checkout/sessions/[id]/retry", () => {
  it("retries an escalated session with a different payment method", async () => {
    const res = await postRetry(escalatedRow.id, { paymentMethod: "fiat" });
    expect(res.statusCode).toBe(200);
    const body = res.body as any;
    expect(body.id).toBe(escalatedRow.id);
    expect(body.status).toBe("ready_for_complete");
    expect(body.payment.method).toBe("fiat");
    expect(body.orderId).toBe("ord_retry_1");
    // The retry is recorded on ONE continued timeline — a session_retried
    // entry, and no second session_created.
    const types = body.messages.map((m: any) => m.type);
    expect(types).toContain("session_retried");
    expect(types.filter((t: string) => t === "session_created")).toHaveLength(
      1
    );
    // The escalation error/code are cleared on the way out.
    expect(body.error).toBeUndefined();
    expect(body.code).toBeUndefined();

    expect(mockClaimCheckoutSessionRetry).toHaveBeenCalledWith(
      escalatedRow.id,
      "buyer-pk"
    );
    expect(mockResolveCheckoutSessionRetry).toHaveBeenCalledWith(
      escalatedRow.id,
      expect.objectContaining({
        status: "ready_for_complete",
        mcpOrderId: "ord_retry_1",
        paymentMethod: "fiat",
      })
    );
    expect(mockFailCheckoutSessionRetry).not.toHaveBeenCalled();
  });

  it("reuses the stored order details (product, quantity) for the retry", async () => {
    const res = await postRetry(escalatedRow.id, { paymentMethod: "fiat" });
    expect(res.statusCode).toBe(200);
    // The real engine priced the order from the stored request: quantity 2
    // (createMcpOrder is positional: orderId, apiKeyId, buyer, seller,
    // productId, title, quantity, total, currency, …).
    const call = mockCreateMcpOrder.mock.calls[0];
    expect(call[4]).toBe("p1");
    expect(call[6]).toBe(2);
    expect(call[7]).toBe(60);
  });

  it("keeps the session escalated with the fresh error/code when the retry escalates again", async () => {
    // Same sats attempt on the USD product — the engine escalates again
    // before any order is placed.
    const res = await postRetry(escalatedRow.id, {
      paymentMethod: "lightning",
    });
    expect(res.statusCode).toBe(200);
    const body = res.body as any;
    expect(body.status).toBe("requires_escalation");
    expect(body.code).toBe("exchange_rate_unavailable");
    expect(typeof body.error).toBe("string");
    const types = body.messages.map((m: any) => m.type);
    expect(types).toContain("session_retried");
    expect(types.filter((t: string) => t === "requires_escalation").length)
      .toBeGreaterThanOrEqual(2);
    expect(mockResolveCheckoutSessionRetry).not.toHaveBeenCalled();
    expect(mockCreateMcpOrder).not.toHaveBeenCalled();
  });

  it("still-escalated retry responses validate against the published session schema", async () => {
    const schemaRes = createResponse();
    await checkoutSessionSchemaHandler(
      { method: "GET", headers: {} } as unknown as NextApiRequest,
      schemaRes as unknown as NextApiResponse
    );
    // strict:false — the published session schema's if/then uses
    // `not: { required: [...] }`, which ajv's strictRequired rejects (the
    // schema-contract suite compiles it the same way).
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(schemaRes.body as Record<string, any>);

    const res = await postRetry(escalatedRow.id, {
      paymentMethod: "lightning",
    });
    expect(res.statusCode).toBe(200);
    const valid = validate(res.body);
    expect(validate.errors).toEqual(null);
    expect(valid).toBe(true);
    // The retriable session advertises its retry action in links.
    expect((res.body as any).links.retry).toBe(
      `https://platform.test/api/ucp/checkout/sessions/${escalatedRow.id}/retry`
    );
  });

  it("rejects retrying a session that is not escalated", async () => {
    mockGetCheckoutSession.mockResolvedValue({
      ...escalatedRow,
      status: "ready_for_complete",
      mcp_order_id: "ord_existing",
    });
    const res = await postRetry(escalatedRow.id, { paymentMethod: "fiat" });
    expect(res.statusCode).toBe(409);
    expect((res.body as any).error).toMatch(/requires_escalation/);
    expect(mockClaimCheckoutSessionRetry).not.toHaveBeenCalled();
  });

  it("rejects retrying a post-order escalation (order already placed)", async () => {
    mockGetCheckoutSession.mockResolvedValue({
      ...escalatedRow,
      mcp_order_id: "ord_failed_1",
    });
    const res = await postRetry(escalatedRow.id, { paymentMethod: "fiat" });
    expect(res.statusCode).toBe(409);
    expect((res.body as any).error).toMatch(/already placed/);
    expect(mockClaimCheckoutSessionRetry).not.toHaveBeenCalled();
  });

  it("returns the same 404 for another key's session (no enumeration)", async () => {
    mockGetCheckoutSession.mockResolvedValue({
      ...escalatedRow,
      buyer_pubkey: "someone-else",
    });
    const res = await postRetry(escalatedRow.id, { paymentMethod: "fiat" });
    expect(res.statusCode).toBe(404);
    expect(mockClaimCheckoutSessionRetry).not.toHaveBeenCalled();
  });

  it("404s a missing session", async () => {
    mockGetCheckoutSession.mockResolvedValue(null);
    const res = await postRetry("ucp_cs_nope", { paymentMethod: "fiat" });
    expect(res.statusCode).toBe(404);
  });

  it("400s an unknown paymentMethod before touching the store", async () => {
    const res = await postRetry(escalatedRow.id, { paymentMethod: "venmo" });
    expect(res.statusCode).toBe(400);
    expect((res.body as any).error).toMatch(/paymentMethod must be one of/);
    expect(mockGetCheckoutSession).not.toHaveBeenCalled();
  });

  it("400s a malformed buyerEmail", async () => {
    const res = await postRetry(escalatedRow.id, {
      paymentMethod: "fiat",
      buyerEmail: "not-an-email",
    });
    expect(res.statusCode).toBe(400);
    expect((res.body as any).error).toMatch(/buyerEmail/);
  });

  it("409s when the atomic claim loses a concurrent retry", async () => {
    mockClaimCheckoutSessionRetry.mockResolvedValue(null);
    const res = await postRetry(escalatedRow.id, { paymentMethod: "fiat" });
    expect(res.statusCode).toBe(409);
    expect(mockCreateMcpOrder).not.toHaveBeenCalled();
  });

  it("fails closed on a hard engine failure: the session is NOT made retriable again", async () => {
    // The product is gone by the time the retry runs: a validation failure.
    // The route can't distinguish pre-order validation errors from engine
    // throws AFTER an order/payment exists, so it must fail closed: the
    // caller gets the engine's 404, and the session stays claimed
    // (non-retriable) via the status-preserving rescue write — never back to
    // a retriable requires_escalation.
    mockFetchAllProductsFromDb.mockResolvedValue([]);
    const res = await postRetry(escalatedRow.id, { paymentMethod: "fiat" });
    expect(res.statusCode).toBe(404);
    expect((res.body as any).error).toMatch(/Product not found/);
    expect(mockFailCheckoutSessionRetry).not.toHaveBeenCalled();
    expect(mockRescueCheckoutSessionRetry).toHaveBeenCalledWith(
      escalatedRow.id,
      expect.objectContaining({
        mcpOrderId: null,
        error: escalatedRow.error,
        code: escalatedRow.code,
      })
    );
    const rescueMessages = mockRescueCheckoutSessionRetry.mock.calls[0][1]
      .messages;
    expect(rescueMessages.map((m: any) => m.type)).toContain("retry_failed");
  });

  it("never makes the session retriable when the success write fails after the order was placed", async () => {
    // The engine created the order, then the resolve write threw: restoring
    // requires_escalation would let a later retry place a SECOND order.
    mockResolveCheckoutSessionRetry.mockRejectedValue(new Error("db down"));
    const res = await postRetry(escalatedRow.id, { paymentMethod: "fiat" });
    expect(res.statusCode).toBe(200);
    const body = res.body as any;
    // The caller still gets the payment descriptor + order id…
    expect(body.orderId).toBe("ord_retry_1");
    expect(body.payment.method).toBe("fiat");
    // …with a loud do-not-retry warning, and NOT a retriable escalation.
    expect(body.warning).toMatch(/do not retry/);
    expect(body.status).not.toBe("requires_escalation");
    expect(mockFailCheckoutSessionRetry).not.toHaveBeenCalled();
    // The rescue write attached the order id, permanently arming the retry
    // route's post-order guard (409) for this session.
    expect(mockRescueCheckoutSessionRetry).toHaveBeenCalledWith(
      escalatedRow.id,
      expect.objectContaining({
        mcpOrderId: "ord_retry_1",
        code: "retry_settle_failed",
      })
    );
  });

  it("never makes the session retriable when a concurrent status update steals the claim fence", async () => {
    // resolveCheckoutSessionRetry returns null when its WHERE
    // status='incomplete' guard no longer matches (e.g. a concurrent
    // /complete flipped the session) — but the engine already placed the
    // order, so the response must still carry the descriptor and the session
    // must stay non-retriable.
    mockResolveCheckoutSessionRetry.mockResolvedValue(null);
    const res = await postRetry(escalatedRow.id, { paymentMethod: "fiat" });
    expect(res.statusCode).toBe(200);
    const body = res.body as any;
    expect(body.orderId).toBe("ord_retry_1");
    expect(body.warning).toMatch(/do not retry/);
    expect(body.status).not.toBe("requires_escalation");
    expect(mockFailCheckoutSessionRetry).not.toHaveBeenCalled();
    expect(mockRescueCheckoutSessionRetry).toHaveBeenCalledWith(
      escalatedRow.id,
      expect.objectContaining({ mcpOrderId: "ord_retry_1" })
    );
  });

  it("403s a retry scoped to a different seller's custom domain", async () => {
    mockResolveHostScope.mockResolvedValue({
      scope: "seller",
      seller: { pubkey: "other-seller" },
    });
    const res = await postRetry(escalatedRow.id, { paymentMethod: "fiat" });
    expect(res.statusCode).toBe(403);
    expect(mockClaimCheckoutSessionRetry).not.toHaveBeenCalled();
  });
});
