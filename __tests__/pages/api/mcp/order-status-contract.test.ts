/** @jest-environment node */

/**
 * Response contract for the MCP order-status read paths agents poll:
 *  - GET /api/mcp/create-order?orderId=... (single order, backs get_order_status)
 *  - GET /api/mcp/create-order            (order list, backs list_orders)
 *
 * Both format their order payloads through formatOrderForResponse
 * (mcp/tools/purchase-tools.ts), which is hand-built with no schema guarding
 * it — a rename there (orderId → id, paymentStatus → payment_state, …) would
 * silently break every agent client while create-order's own contract tests
 * kept passing.
 *
 * This test drives the REAL GET handler arms with the order-service/db seams
 * mocked (like verify-payment-contract.test.ts) but keeps the REAL
 * formatOrderForResponse, captures the wire bodies, and validates them
 * closed: the { success, order } / { success, orders, pagination } envelopes
 * and every order field name. A rename on either side (route/formatter OR
 * this schema) fails the test.
 */

import type { NextApiRequest, NextApiResponse } from "next";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

import type { JsonSchema } from "@/utils/ucp/payment-descriptor-schema";

const mockApplyRateLimit = jest.fn();
const mockAuthenticateRequest = jest.fn();
const mockInitializeApiKeysTable = jest.fn();
const mockGetMcpOrder = jest.fn();
const mockListMcpOrders = jest.fn();

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

// Partial mock: the DB readers are stubbed, but formatOrderForResponse stays
// REAL — it is the very thing this contract pins, so mocking it (the way the
// authorization tests do) would let a rename pass silently.
jest.mock("@/mcp/tools/purchase-tools", () => ({
  ...jest.requireActual("@/mcp/tools/purchase-tools"),
  getMcpOrder: (...args: any[]) => mockGetMcpOrder(...args),
  listMcpOrders: (...args: any[]) => mockListMcpOrders(...args),
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

import createOrderHandler from "@/pages/api/mcp/create-order";

// --- MCP order payload contract ----------------------------------------------
// The shape agents read: exactly these 13 fields, nothing more. Nullable
// fields stay nullable (a missing product title or buyer email must not turn
// into an absent key — agents key off the field's presence).

const ORDER_FIELDS = [
  "orderId",
  "productId",
  "productTitle",
  "quantity",
  "amountTotal",
  "currency",
  "buyerEmail",
  "shippingAddress",
  "paymentStatus",
  "orderStatus",
  "paymentIntentId",
  "createdAt",
  "updatedAt",
] as const;

const MCP_ORDER: JsonSchema = {
  type: "object",
  properties: {
    orderId: { type: "string" },
    productId: { type: "string" },
    productTitle: { type: ["string", "null"] },
    quantity: { type: "number" },
    amountTotal: { type: "number" },
    currency: { type: "string" },
    buyerEmail: { type: ["string", "null"] },
    // Buyer-supplied free-form address: the object itself is pinned present,
    // its inner keys are the buyer's data, not our contract.
    shippingAddress: { type: ["object", "null"] },
    paymentStatus: { type: "string" },
    orderStatus: { type: "string" },
    paymentIntentId: { type: ["string", "null"] },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
  required: [...ORDER_FIELDS],
  additionalProperties: false,
};

const GET_ORDER_ENVELOPE: JsonSchema = {
  type: "object",
  properties: {
    success: { const: true },
    order: MCP_ORDER,
  },
  required: ["success", "order"],
  additionalProperties: false,
};

const LIST_ORDERS_ENVELOPE: JsonSchema = {
  type: "object",
  properties: {
    success: { const: true },
    orders: { type: "array", items: MCP_ORDER },
    pagination: {
      type: "object",
      properties: {
        limit: { type: "integer" },
        offset: { type: "integer" },
        count: { type: "integer" },
      },
      required: ["limit", "offset", "count"],
      additionalProperties: false,
    },
  },
  required: ["success", "orders", "pagination"],
  additionalProperties: false,
};

function compile(subschema: JsonSchema) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(subschema);
}

// --- Route driving ------------------------------------------------------------

const BUYER_PK = "buyer-pk";
const SELLER_PK = "seller-pk";

// A fully-populated mcp_orders row (snake_case, as Postgres returns it;
// numeric columns arrive as strings, which formatOrderForResponse parses).
const ORDER_ROW = {
  id: 1,
  order_id: "order-1",
  api_key_id: 7,
  buyer_pubkey: BUYER_PK,
  seller_pubkey: SELLER_PK,
  product_id: "product-1",
  product_title: "Raw Milk",
  quantity: 2,
  amount_total: "42.50",
  currency: "USD",
  buyer_email: "buyer@example.com",
  shipping_address: {
    name: "Buyer",
    address: "1 Main St",
    city: "Town",
    postalCode: "00000",
    stateProvince: "ST",
    country: "US",
  },
  payment_intent_id: "pi_123",
  payment_status: "paid",
  order_status: "confirmed",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-02T00:00:00.000Z",
};

function createResponse() {
  return {
    statusCode: 200,
    body: undefined as any,
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

async function runGet(query: Record<string, string>) {
  const res = createResponse();
  await createOrderHandler(
    {
      method: "GET",
      headers: {},
      query,
      body: {},
      socket: { remoteAddress: "203.0.113.7" },
    } as unknown as NextApiRequest,
    res as unknown as NextApiResponse
  );
  // JSON round-trip: the wire is the contract.
  return {
    statusCode: res.statusCode,
    body: JSON.parse(JSON.stringify(res.body)),
  };
}

async function getOrder(order: Record<string, unknown> | null) {
  mockGetMcpOrder.mockResolvedValue(order);
  return runGet({ orderId: "order-1" });
}

async function listOrders(rows: Record<string, unknown>[]) {
  mockListMcpOrders.mockResolvedValue(rows);
  return runGet({});
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  mockApplyRateLimit.mockResolvedValue(true);
  mockInitializeApiKeysTable.mockResolvedValue(undefined);
  mockAuthenticateRequest.mockResolvedValue({ id: 7, pubkey: BUYER_PK });
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore?.();
});

describe("MCP order-status read contract", () => {
  it("GET ?orderId=: closed { success, order } envelope with all 13 order fields", async () => {
    const { statusCode, body } = await getOrder(ORDER_ROW);
    expect(statusCode).toBe(200);
    const validate = compile(GET_ORDER_ENVELOPE);
    const ok: boolean = validate(body);
    expect(ok ? true : JSON.stringify(validate.errors)).toBe(true);
    // Value mapping is part of the contract too: snake_case row columns land
    // on the camelCase wire fields agents read.
    expect(body.order.orderId).toBe("order-1");
    expect(body.order.amountTotal).toBe(42.5);
    expect(body.order.paymentStatus).toBe("paid");
    expect(body.order.orderStatus).toBe("confirmed");
    expect(body.order.paymentIntentId).toBe("pi_123");
    expect(body.order.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("GET ?orderId=: nullable fields stay present as null, never absent", async () => {
    const { statusCode, body } = await getOrder({
      ...ORDER_ROW,
      product_title: null,
      buyer_email: null,
      shipping_address: null,
      payment_intent_id: null,
    });
    expect(statusCode).toBe(200);
    const validate = compile(GET_ORDER_ENVELOPE);
    const ok: boolean = validate(body);
    expect(ok ? true : JSON.stringify(validate.errors)).toBe(true);
    expect(body.order.productTitle).toBeNull();
    expect(body.order.buyerEmail).toBeNull();
    expect(body.order.shippingAddress).toBeNull();
    expect(body.order.paymentIntentId).toBeNull();
  });

  it("GET (list): closed { success, orders, pagination } envelope; every order matches", async () => {
    const { statusCode, body } = await listOrders([
      ORDER_ROW,
      { ...ORDER_ROW, id: 2, order_id: "order-2", order_status: "shipped" },
    ]);
    expect(statusCode).toBe(200);
    const validate = compile(LIST_ORDERS_ENVELOPE);
    const ok: boolean = validate(body);
    expect(ok ? true : JSON.stringify(validate.errors)).toBe(true);
    expect(body.orders).toHaveLength(2);
    expect(body.pagination).toEqual({ limit: 50, offset: 0, count: 2 });
    expect(body.orders[1].orderId).toBe("order-2");
    expect(body.orders[1].orderStatus).toBe("shipped");
  });

  it("GET (list): empty result still returns the closed envelope", async () => {
    const { statusCode, body } = await listOrders([]);
    expect(statusCode).toBe(200);
    const validate = compile(LIST_ORDERS_ENVELOPE);
    const ok: boolean = validate(body);
    expect(ok ? true : JSON.stringify(validate.errors)).toBe(true);
    expect(body.orders).toEqual([]);
    expect(body.pagination.count).toBe(0);
  });

  // --- Drift pins: one-sided renames must fail closed -------------------------

  it.each([
    ["orderId", "id"],
    ["productId", "product"],
    ["productTitle", "title"],
    ["quantity", "qty"],
    ["amountTotal", "total"],
    ["currency", "unit"],
    ["buyerEmail", "email"],
    ["shippingAddress", "address"],
    ["paymentStatus", "payment_state"],
    ["orderStatus", "status"],
    ["paymentIntentId", "paymentIntent"],
    ["createdAt", "created"],
    ["updatedAt", "updated"],
  ])(
    "fails closed when order field %s is renamed in formatOrderForResponse",
    async (from, to) => {
      const { body } = await getOrder(ORDER_ROW);
      const driftedOrder = JSON.parse(
        JSON.stringify({ ...body.order, [from]: undefined, [to]: body.order[from] })
      );
      const validateGet = compile(GET_ORDER_ENVELOPE);
      expect(validateGet({ ...body, order: driftedOrder })).toBe(false);
      // The same formatter backs the list read — a rename breaks it too.
      const validateList = compile(LIST_ORDERS_ENVELOPE);
      expect(
        validateList({
          success: true,
          orders: [driftedOrder],
          pagination: { limit: 50, offset: 0, count: 1 },
        })
      ).toBe(false);
    }
  );

  it("fails closed when envelope fields are renamed in the route", async () => {
    const { body: getBody } = await getOrder(ORDER_ROW);
    const validateGet = compile(GET_ORDER_ENVELOPE);
    expect(validateGet({ ...getBody, success: undefined, ok: true })).toBe(
      false
    );
    expect(validateGet({ ...getBody, order: undefined, result: getBody.order })).toBe(
      false
    );

    const { body: listBody } = await listOrders([ORDER_ROW]);
    const validateList = compile(LIST_ORDERS_ENVELOPE);
    expect(
      validateList({ ...listBody, orders: undefined, results: listBody.orders })
    ).toBe(false);
    expect(
      validateList({
        ...listBody,
        pagination: undefined,
        page: listBody.pagination,
      })
    ).toBe(false);
  });

  it("rejects an unexpected extra field on the envelope and on the order", async () => {
    const { body } = await getOrder(ORDER_ROW);
    const validate = compile(GET_ORDER_ENVELOPE);
    expect(validate({ ...body, surpriseField: 1 })).toBe(false);
    expect(
      validate({ ...body, order: { ...body.order, surpriseField: 1 } })
    ).toBe(false);
  });
});
