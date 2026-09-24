/** @jest-environment node */

/**
 * Order/pricing contract for POST /api/mcp/create-order.
 *
 * The payment-descriptor contract test (create-order-payment-contract.test.ts)
 * pins only the per-method `payment` descriptors. The same MCP envelopes also
 * carry:
 *   - `order`   — formatOrderForResponse (mcp/tools/purchase-tools.ts), the
 *                 snake_case → camelCase mapping agent clients read for the
 *                 order id, totals, and statuses.
 *   - `pricing` — the engine's pricingBlock (computeQuoteTotals in
 *                 utils/ucp/order-service.ts), passed through verbatim by the
 *                 route and read by agents for line-item pricing.
 * A rename in either mapping (orderId → id, amountTotal → total,
 * shippingCost → shipping, …) would silently break agent clients while every
 * other contract test kept passing.
 *
 * This test drives the REAL handler and the REAL formatOrderForResponse (only
 * the order engine's createOrderFlow is stubbed), captures the wire body of
 * each envelope, and validates `order` + `pricing` against CLOSED schemas
 * (additionalProperties: false). It also runs the REAL computeQuoteTotals so
 * a rename inside the engine's pricingBlock build fails here too — the wire
 * is a verbatim passthrough, so the schema must be pinned on both sides.
 */

import type { NextApiRequest, NextApiResponse } from "next";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

import type { OrderFlowResult } from "@/utils/ucp/order-service";
import type { McpOrder } from "@/mcp/tools/purchase-tools";

const mockApplyRateLimit = jest.fn();
const mockAuthenticateRequest = jest.fn();
const mockInitializeApiKeysTable = jest.fn();
const mockCreateOrderFlow = jest.fn();
const mockFetchAllProfilesFromDb = jest.fn();
const mockValidateDiscountCode = jest.fn();

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

// REAL formatOrderForResponse (the mapping under test); only the order-read
// helpers the route also imports are stubbed.
jest.mock("@/mcp/tools/purchase-tools", () => ({
  ...jest.requireActual("@/mcp/tools/purchase-tools"),
  getMcpOrder: jest.fn(),
  listMcpOrders: jest.fn(),
}));

// REAL order engine except createOrderFlow (stubbed so the route can be
// driven per payment method). computeQuoteTotals stays real so the engine's
// pricingBlock build is validated against the same closed pricing schema.
jest.mock("@/utils/ucp/order-service", () => ({
  ...jest.requireActual("@/utils/ucp/order-service"),
  createOrderFlow: (...args: any[]) => mockCreateOrderFlow(...args),
}));

jest.mock("@/utils/db/db-service", () => ({
  // getDbPool is called at module scope by real utils/db/* modules; a mock
  // without it kills the whole suite at import time.
  getDbPool: jest.fn(),
  fetchAllProductsFromDb: jest.fn(async () => []),
  fetchAllProfilesFromDb: (...args: any[]) =>
    mockFetchAllProfilesFromDb(...args),
  getStripeConnectAccount: jest.fn(async () => null),
  validateDiscountCode: (...args: any[]) => mockValidateDiscountCode(...args),
  markDiscountCodeUsed: jest.fn(),
}));

jest.mock("@/utils/db/inventory-service", () => ({
  checkAvailability: jest.fn(async () => ({ tracked: false })),
  deductStock: jest.fn(),
}));

jest.mock("@cashu/cashu-ts", () => ({
  Mint: jest.fn(),
  Wallet: jest.fn(),
  MintQuoteState: { UNPAID: "UNPAID", PAID: "PAID", ISSUED: "ISSUED" },
}));

import createOrderHandler from "@/pages/api/mcp/create-order";
import { computeQuoteTotals } from "@/utils/ucp/order-service";

// --- Closed wire schemas ------------------------------------------------------

// formatOrderForResponse (mcp/tools/purchase-tools.ts). Every key is always
// emitted; nullable columns arrive as null, never absent.
const MCP_ORDER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    orderId: { type: "string" },
    productId: { type: "string" },
    productTitle: { type: ["string", "null"] },
    quantity: { type: "number" },
    amountTotal: { type: "number" },
    currency: { type: "string" },
    buyerEmail: { type: ["string", "null"] },
    shippingAddress: { type: ["object", "null"] },
    paymentStatus: { type: "string" },
    orderStatus: { type: "string" },
    paymentIntentId: { type: ["string", "null"] },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
  required: [
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
  ],
} as const;

// The engine's pricingBlock (computeQuoteTotals), passed through verbatim as
// `pricing`. discount* keys are present only when a discount code applied;
// selectedSpecs only when the buyer picked a variant.
const MCP_PRICING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    unitPrice: { type: "number" },
    quantity: { type: "number" },
    subtotal: { type: "number" },
    discountPercentage: { type: "number" },
    discountedSubtotal: { type: "number" },
    shippingCost: { type: "number" },
    total: { type: "number" },
    currency: { type: "string" },
    selectedSpecs: { type: "object" },
  },
  required: [
    "unitPrice",
    "quantity",
    "subtotal",
    "shippingCost",
    "total",
    "currency",
  ],
} as const;

function compile(subschema: object) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(subschema);
}

function expectValid(subschema: object, label: string, payload: unknown) {
  const validate = compile(subschema);
  const ok: boolean = validate(payload);
  expect(ok ? true : `${label} rejected: ${JSON.stringify(validate.errors)}`)
    .toBe(true);
}

// --- Route driving ------------------------------------------------------------

const SELLER_PUBKEY = "cd".repeat(32);

const MCP_ORDER: McpOrder = {
  id: 1,
  order_id: "mcp_order_1",
  api_key_id: 7,
  buyer_pubkey: "buyer-pk",
  seller_pubkey: SELLER_PUBKEY,
  product_id: "product-1",
  product_title: "Raw Cheddar",
  quantity: 2,
  amount_total: 20,
  currency: "usd",
  buyer_email: "buyer@example.com",
  shipping_address: {
    name: "Buyer",
    address: "1 Main St",
    city: "Springfield",
    postalCode: "00000",
    stateProvince: "IL",
    country: "US",
  },
  payment_intent_id: null,
  payment_status: "pending",
  order_status: "pending",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

// Realistic full pricingBlock (matches the engine's build, discount applied).
const PRICING_BLOCK = {
  unitPrice: 10,
  quantity: 2,
  subtotal: 20,
  discountPercentage: 10,
  discountedSubtotal: 18,
  shippingCost: 2,
  total: 20,
  currency: "usd",
  selectedSpecs: { size: "M" },
};

// `satisfies` (not a Record annotation) keeps each entry's literal type so
// keyed access stays defined under noUncheckedIndexedAccess.
const RESULTS = {
  lightning: {
    kind: "lightning",
    order: MCP_ORDER,
    bolt11: "lnbc15u1p...",
    quoteId: "quote_1",
    amountSats: 1500,
    mintUrl: "https://mint.example",
    expiresAt: "2030-01-01T01:00:00.000Z",
    pricingBlock: PRICING_BLOCK,
  },
  cashu: {
    kind: "cashu",
    order: MCP_ORDER,
    tokenAmount: 1500,
    requiredAmount: 1500,
    change: 0,
    pricingBlock: PRICING_BLOCK,
  },
  fiat: {
    kind: "fiat",
    order: MCP_ORDER,
    fiatOptions: ["Venmo @seller"],
    selectedMethod: "Venmo @seller",
    sellerContact: { name: "Seller", nip05: "seller@example.com" },
    amount: 12.5,
    currency: "usd",
    pricingBlock: PRICING_BLOCK,
  },
  stripe: {
    kind: "stripe",
    order: MCP_ORDER,
    paymentIntentId: "pi_1",
    clientSecret: "pi_1_secret",
    connectedAccountId: "acct_1",
    amount: 12.5,
    currency: "usd",
    pricingBlock: PRICING_BLOCK,
  },
  stripeFree: {
    kind: "stripe",
    order: MCP_ORDER,
    paymentIntentId: null,
    clientSecret: null,
    connectedAccountId: null,
    amount: 0,
    currency: "usd",
    pricingBlock: PRICING_BLOCK,
  },
  subscription: {
    kind: "subscription",
    subscriptionId: "sub_1",
    frequency: "monthly",
    status: "incomplete",
    currentPeriodEnd: 1_700_000_000,
    recurringAmount: 10,
    currency: "usd",
    quantity: 1,
    discountPercent: 0,
    clientSecret: "sub_1_secret",
    customerId: "cus_1",
    connectedAccountId: "acct_1",
  },
} satisfies Record<string, OrderFlowResult>;

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

async function postForResult(result: OrderFlowResult) {
  mockCreateOrderFlow.mockResolvedValue(result);
  const res = createResponse();
  await createOrderHandler(
    {
      method: "POST",
      headers: {},
      query: {},
      body: { productId: "product-1" },
      socket: { remoteAddress: "203.0.113.7" },
    } as unknown as NextApiRequest,
    res as unknown as NextApiResponse
  );
  // JSON round-trip: the wire is the contract. Drops `undefined`-valued keys
  // exactly as res.json serialization would.
  return {
    statusCode: res.statusCode,
    body: JSON.parse(JSON.stringify(res.body)),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  mockApplyRateLimit.mockResolvedValue(true);
  mockInitializeApiKeysTable.mockResolvedValue(undefined);
  mockAuthenticateRequest.mockResolvedValue({ id: 7, pubkey: "buyer-pk" });
  mockFetchAllProfilesFromDb.mockResolvedValue([]);
  mockValidateDiscountCode.mockResolvedValue({ valid: false });
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore?.();
});

describe("MCP create-order order/pricing payloads", () => {
  it.each([
    ["lightning", 402],
    ["cashu", 201],
    ["fiat", 402],
    ["stripe", 402],
    ["stripeFree", 201],
  ] as const)(
    "%s envelope carries a closed order + pricing payload",
    async (key, expectedStatus) => {
      const { statusCode, body } = await postForResult(RESULTS[key]);
      expect(statusCode).toBe(expectedStatus);
      expectValid(MCP_ORDER_SCHEMA, `${key}.order`, body.order);
      expectValid(MCP_PRICING_SCHEMA, `${key}.pricing`, body.pricing);
    }
  );

  it("order payload is produced by the REAL formatOrderForResponse mapping", async () => {
    const { body } = await postForResult(RESULTS.stripe);
    // Spot-check the actual snake_case → camelCase renames so a stubbed or
    // bypassed mapper cannot keep this suite green.
    expect(body.order.orderId).toBe(MCP_ORDER.order_id);
    expect(body.order.amountTotal).toBe(MCP_ORDER.amount_total);
    expect(body.order.paymentStatus).toBe(MCP_ORDER.payment_status);
    expect(body.order.createdAt).toBe(MCP_ORDER.created_at);
  });

  it("cashu order is reported as paid", async () => {
    const { body } = await postForResult(RESULTS.cashu);
    expect(body.order.paymentStatus).toBe("paid");
  });

  it("pricing is the engine's pricingBlock passed through verbatim", async () => {
    const { body } = await postForResult(RESULTS.lightning);
    expect(body.pricing).toEqual(PRICING_BLOCK);
  });

  it("subscription envelope deliberately carries NO order/pricing keys", async () => {
    const { statusCode, body } = await postForResult(RESULTS.subscription);
    expect(statusCode).toBe(402);
    // The recurring arm splits into `subscription` + `payment` instead; an
    // agent reading order/pricing here must see absence, not a stale shape.
    expect(body).not.toHaveProperty("order");
    expect(body).not.toHaveProperty("pricing");
  });

  // --- Engine side: the real computeQuoteTotals pricingBlock build -----------

  function buildSelection() {
    return {
      product: {
        pubkey: SELLER_PUBKEY,
        price: 10,
        currency: "usd",
        shippingCost: 2,
        shippingType: "flat",
      },
      productId: "product-1",
      quantity: 2,
      unitPrice: 10,
      currency: "usd",
      selectedSpecs: { size: "M" },
    };
  }

  const QUOTE_INPUT = {
    productId: "product-1",
    quantity: 2,
    paymentMethod: "stripe",
    apiKeyId: 7,
    buyerPubkey: "buyer-pk",
  } as any;

  it("engine pricingBlock (no discount) matches the closed pricing schema", async () => {
    const quote = await computeQuoteTotals(
      QUOTE_INPUT,
      buildSelection() as any,
      "stripe"
    );
    expectValid(MCP_PRICING_SCHEMA, "pricingBlock", quote.pricingBlock);
    // No discount code → discount keys absent on the wire (the engine sets
    // them to undefined, which JSON serialization drops).
    const wire = JSON.parse(JSON.stringify(quote.pricingBlock));
    expect(wire).not.toHaveProperty("discountPercentage");
    expect(wire).not.toHaveProperty("discountedSubtotal");
  });

  it("engine pricingBlock (discount applied) matches the closed pricing schema", async () => {
    mockValidateDiscountCode.mockResolvedValue({
      valid: true,
      discount_percentage: 10,
    });
    const quote = await computeQuoteTotals(
      { ...QUOTE_INPUT, discountCode: "SAVE10" },
      buildSelection() as any,
      "stripe"
    );
    expectValid(MCP_PRICING_SCHEMA, "pricingBlock", quote.pricingBlock);
    expect(quote.pricingBlock.discountPercentage).toBe(10);
    expect(quote.pricingBlock.discountedSubtotal).toBe(18);
  });

  // --- Drift pins: one-sided renames must fail closed -------------------------

  it.each([
    ["orderId", "id"],
    ["amountTotal", "total"],
    ["paymentStatus", "status"],
    ["shippingAddress", "address"],
  ])(
    "fails closed when the order field %s is renamed in the mapper",
    async (from, to) => {
      const { body } = await postForResult(RESULTS.stripe);
      const drifted = JSON.parse(
        JSON.stringify({ ...body.order, [from]: undefined, [to]: "x" })
      );
      expect(compile(MCP_ORDER_SCHEMA)(drifted)).toBe(false);
    }
  );

  it.each([
    ["unitPrice", "price"],
    ["subtotal", "subtotalAmount"],
    ["shippingCost", "shipping"],
    ["total", "totalAmount"],
  ])(
    "fails closed when the pricing field %s is renamed",
    async (from, to) => {
      const quote = await computeQuoteTotals(
        QUOTE_INPUT,
        buildSelection() as any,
        "stripe"
      );
      const drifted = JSON.parse(
        JSON.stringify({ ...quote.pricingBlock, [from]: undefined, [to]: 1 })
      );
      expect(compile(MCP_PRICING_SCHEMA)(drifted)).toBe(false);
    }
  );

  it("rejects an unexpected extra field on the order payload", async () => {
    const { body } = await postForResult(RESULTS.stripe);
    expect(
      compile(MCP_ORDER_SCHEMA)({ ...body.order, surpriseField: 1 })
    ).toBe(false);
  });

  it("rejects an unexpected extra field on the pricing payload", async () => {
    const quote = await computeQuoteTotals(
      QUOTE_INPUT,
      buildSelection() as any,
      "stripe"
    );
    expect(
      compile(MCP_PRICING_SCHEMA)({ ...quote.pricingBlock, surpriseField: 1 })
    ).toBe(false);
  });
});
