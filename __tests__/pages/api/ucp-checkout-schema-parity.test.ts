/** @jest-environment node */

/**
 * Parity pin: the PUBLISHED request schema for POST /api/ucp/checkout/sessions
 * must accept exactly the payloads the route accepts and reject exactly the
 * ones it rejects — a schema that disagrees with the route is worse than none,
 * because agent clients trust it to pre-validate before POSTing.
 *
 * How it works:
 *  1. The schema is fetched from its own endpoint handler
 *     (pages/api/ucp/schemas/checkout-session-create.json.ts), NOT
 *     reconstructed here, so the thing validated is the thing clients download.
 *  2. Known-good / known-bad bodies are run through a real JSON Schema
 *     validator (ajv, draft 2020-12 — the draft the document declares, with
 *     ajv-formats for format: email/uri) against that document, compiled
 *     verbatim including its $schema/$id.
 *  3. The SAME bodies are POSTed through the real route handler with the REAL
 *     order engine (utils/ucp/order-service.ts is deliberately NOT mocked, as
 *     in order-quantity-cap-routes.test.ts) — only its DB/payment seams are
 *     stubbed, and STRIPE_SECRET_KEY is unset so the engine's Stripe branch is
 *     skipped instead of making a network call. Range/integer rejections of
 *     quantity therefore come from the production engine itself, not from a
 *     reimplementation of its guards in this suite.
 *  4. Every case asserts accept/reject parity between (2) and (3).
 */

import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { NextApiRequest, NextApiResponse } from "next";
import { MAX_ORDER_QUANTITY } from "@/utils/ucp/order-limits";

const mockApplyRateLimit = jest.fn();
const mockAuthenticateRequest = jest.fn();
const mockInitializeApiKeysTable = jest.fn();
const mockResolveHostScope = jest.fn();
const mockFetchAllProductsFromDb = jest.fn();
const mockParseTags = jest.fn();
const mockInsertCheckoutSession = jest.fn();
const mockCreateMcpOrder = jest.fn();

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: (...args: any[]) => mockApplyRateLimit(...args),
}));

jest.mock("@/utils/mcp/auth", () => ({
  authenticateRequest: (...args: any[]) => mockAuthenticateRequest(...args),
  initializeApiKeysTable: (...args: any[]) =>
    mockInitializeApiKeysTable(...args),
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

// NOTE: @/utils/ucp/order-service is intentionally NOT mocked — the real
// engine runs so the quantity bounds under parity test are the production
// guards themselves.

// Handlers under test (imported AFTER the mocks above).
import checkoutSessionsHandler from "@/pages/api/ucp/checkout/sessions";
import checkoutSessionCreateSchemaHandler from "@/pages/api/ucp/schemas/checkout-session-create.json";

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

/** GET the published schema document from its own endpoint. */
async function fetchPublishedSchema(): Promise<Record<string, any>> {
  const res = createResponse();
  await checkoutSessionCreateSchemaHandler(
    { method: "GET", headers: {} } as unknown as NextApiRequest,
    res as unknown as NextApiResponse
  );
  expect(res.statusCode).toBe(200);
  return res.body as Record<string, any>;
}

/** Compile the published schema verbatim with its declared draft (2020-12). */
function compilePublishedSchema(schema: Record<string, any>) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

/** POST a body through the real route handler + real order engine. */
async function postToRoute(
  body: Record<string, unknown>
): Promise<ReturnType<typeof createResponse>> {
  const res = createResponse();
  await checkoutSessionsHandler(
    {
      method: "POST",
      headers: {},
      query: {},
      body,
      socket: { remoteAddress: "203.0.113.7" },
    } as unknown as NextApiRequest,
    res as unknown as NextApiResponse
  );
  return res;
}

let savedStripeSecretKey: string | undefined;

beforeAll(() => {
  // The real engine only constructs a Stripe client when STRIPE_SECRET_KEY is
  // set; unset it for this suite so an accepted order skips the Stripe branch
  // (paymentIntentId stays null) instead of making a live network call.
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
  // A realistically parsed product so the real engine can price a valid order.
  mockParseTags.mockReturnValue({
    pubkey: "seller-pk",
    title: "Test Product",
    price: 30,
    currency: "USD",
  });
  mockInsertCheckoutSession.mockImplementation(async (row: any) => row);
  mockCreateMcpOrder.mockResolvedValue({
    order_id: "ord_1",
    amount_total: 3000,
    currency: "USD",
  });
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore?.();
});

describe("published checkout-session-create schema parity with the route", () => {
  it("declares quantity bounds from the shared MAX_ORDER_QUANTITY constant", async () => {
    const schema = await fetchPublishedSchema();
    expect(schema.$id).toBe(
      "https://platform.test/api/ucp/schemas/checkout-session-create.json"
    );
    expect(schema.properties.quantity).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: MAX_ORDER_QUANTITY,
    });
    expect(schema.properties.productId).toMatchObject({
      type: "string",
      minLength: 1,
    });
    expect(schema.required).toContain("productId");
  });

  const acceptedBodies: Array<[string, Record<string, unknown>]> = [
    ["minimal body (quantity omitted)", { productId: "p1" }],
    ["quantity 1", { productId: "p1", quantity: 1 }],
    ["an ordinary quantity", { productId: "p1", quantity: 3 }],
    [
      "quantity at the MAX_ORDER_QUANTITY boundary",
      { productId: "p1", quantity: MAX_ORDER_QUANTITY },
    ],
  ];

  const rejectedBodies: Array<[string, Record<string, unknown>]> = [
    ["missing productId", { quantity: 2 }],
    ["an empty-string productId", { productId: "" }],
    ["a non-string productId", { productId: 123 }],
    ["an integer-as-string quantity", { productId: "p1", quantity: "5" }],
    ["a null quantity", { productId: "p1", quantity: null }],
    ["quantity 0", { productId: "p1", quantity: 0 }],
    ["a negative quantity", { productId: "p1", quantity: -2 }],
    ["a non-integer quantity", { productId: "p1", quantity: 2.5 }],
    [
      "quantity above MAX_ORDER_QUANTITY",
      { productId: "p1", quantity: MAX_ORDER_QUANTITY + 1 },
    ],
  ];

  it.each(acceptedBodies)(
    "BOTH accept %s (schema valid, route creates a session)",
    async (_label, body) => {
      const schema = await fetchPublishedSchema();
      const validate = compilePublishedSchema(schema);

      const schemaValid = validate(body);
      const res = await postToRoute(body);

      expect(schemaValid).toBe(true);
      expect(res.statusCode).toBe(201);
      // Parity: schema-accepted must mean route-accepted.
      expect(res.statusCode !== 400).toBe(schemaValid);
      // ...and the acceptance genuinely ran through the real order engine.
      expect(mockCreateMcpOrder).toHaveBeenCalled();
    }
  );

  it.each(rejectedBodies)(
    "BOTH reject %s (schema invalid, route 400s)",
    async (_label, body) => {
      const schema = await fetchPublishedSchema();
      const validate = compilePublishedSchema(schema);

      const schemaValid = validate(body);
      const res = await postToRoute(body);

      expect(schemaValid).toBe(false);
      expect(res.statusCode).toBe(400);
      // Parity: schema-rejected must mean route-rejected.
      expect(res.statusCode !== 400).toBe(schemaValid);
      // ...and a rejected body never becomes an order or a session row.
      expect(mockCreateMcpOrder).not.toHaveBeenCalled();
      expect(mockInsertCheckoutSession).not.toHaveBeenCalled();
    }
  );
});
