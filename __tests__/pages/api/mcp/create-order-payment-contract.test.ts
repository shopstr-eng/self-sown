/** @jest-environment node */

/**
 * Payment-descriptor contract for POST /api/mcp/create-order.
 *
 * The route formats the SAME OrderFlowResult the UCP checkout engine produces,
 * but through its own legacy field mapping (formatCreateOrderResult) with no
 * schema guarding it — a rename there (bolt11 → invoice, availableMethods →
 * methods, …) would silently break agent tool clients while the advertised
 * UCP checkout-session schema kept passing its own contract test.
 *
 * This test drives the REAL handler with a fabricated OrderFlowResult per
 * payment method, captures the wire body, and validates each `payment`
 * descriptor against an MCP-flavored composition of the SAME shared field
 * contracts (utils/ucp/payment-descriptor-schema.ts) the published UCP schema
 * is built from. MCP-specific extras (instructions, expiresAt) and omissions
 * (no `method` on the lightning/stripe arms, no verifyUrl on lightning) are
 * declared explicitly in the compositions, so the shared fields are validated
 * closed on both sides: rename a field in the route OR in the shared module
 * used by only one surface and this test (or the UCP sibling) fails.
 */

import type { NextApiRequest, NextApiResponse } from "next";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

import {
  composePaymentDescriptor,
  LIGHTNING_DESCRIPTOR_PROPERTIES,
  LIGHTNING_DESCRIPTOR_REQUIRED,
  CASHU_DESCRIPTOR_PROPERTIES,
  CASHU_DESCRIPTOR_REQUIRED,
  FIAT_DESCRIPTOR_PROPERTIES,
  FIAT_DESCRIPTOR_REQUIRED,
  STRIPE_ONE_TIME_DESCRIPTOR_PROPERTIES,
  STRIPE_ONE_TIME_DESCRIPTOR_REQUIRED,
  STRIPE_SUBSCRIPTION_DESCRIPTOR_PROPERTIES,
  STRIPE_SUBSCRIPTION_DESCRIPTOR_REQUIRED,
  type JsonSchema,
} from "@/utils/ucp/payment-descriptor-schema";
import type { OrderFlowResult } from "@/utils/ucp/order-service";

const mockApplyRateLimit = jest.fn();
const mockAuthenticateRequest = jest.fn();
const mockInitializeApiKeysTable = jest.fn();
const mockFormatOrderForResponse = jest.fn();
const mockCreateOrderFlow = jest.fn();

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
  getMcpOrder: jest.fn(),
  listMcpOrders: jest.fn(),
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

// --- MCP descriptor subschemas: shared field contracts + MCP deltas ---------
// Each MCP delta is deliberate and pinned here; anything NOT listed must match
// the UCP-advertised field contract exactly.

const MCP_INSTRUCTIONS = { type: "object" } as const;

const MCP_LIGHTNING_PAYMENT = composePaymentDescriptor(
  LIGHTNING_DESCRIPTOR_PROPERTIES,
  LIGHTNING_DESCRIPTOR_REQUIRED,
  {
    // The envelope already carries paymentMethod:"lightning"; settlement is
    // verified via POST /api/mcp/verify-payment (named in instructions), not a
    // verifyUrl field. MCP adds an invoice expiry + human/agent instructions.
    omit: ["verifyUrl"],
    extraProperties: { expiresAt: { type: "string" }, instructions: MCP_INSTRUCTIONS },
    extraRequired: ["expiresAt", "instructions"],
  }
);

// Cashu is the one arm where the MCP descriptor is byte-identical to the UCP
// descriptor — same composition, discriminator included.
const MCP_CASHU_PAYMENT = composePaymentDescriptor(
  CASHU_DESCRIPTOR_PROPERTIES,
  CASHU_DESCRIPTOR_REQUIRED,
  { method: "cashu" }
);

const MCP_FIAT_PAYMENT = composePaymentDescriptor(
  FIAT_DESCRIPTOR_PROPERTIES,
  FIAT_DESCRIPTOR_REQUIRED,
  {
    method: "fiat",
    extraProperties: { instructions: MCP_INSTRUCTIONS },
    extraRequired: ["instructions"],
  }
);

const MCP_STRIPE_ONE_TIME_PAYMENT = composePaymentDescriptor(
  STRIPE_ONE_TIME_DESCRIPTOR_PROPERTIES,
  STRIPE_ONE_TIME_DESCRIPTOR_REQUIRED,
  {
    // No `method` key (envelope says paymentMethod:"stripe"); the route emits
    // connectedAccountId only when the seller has a connected account.
    optional: ["connectedAccountId"],
    extraProperties: { instructions: MCP_INSTRUCTIONS },
    extraRequired: ["instructions"],
  }
);

// The MCP subscription arm splits the descriptor: clientSecret/customerId/
// connectedAccountId (+instructions) under `payment`, and the recurring-billing
// fields under a separate `subscription` object. Validate both halves against
// the shared subscription field contract.
const MCP_SUBSCRIPTION_PAYMENT = composePaymentDescriptor(
  STRIPE_SUBSCRIPTION_DESCRIPTOR_PROPERTIES,
  STRIPE_SUBSCRIPTION_DESCRIPTOR_REQUIRED,
  {
    omit: [
      "type",
      "subscriptionId",
      "frequency",
      "recurringAmount",
      "currency",
    ],
    extraProperties: { instructions: MCP_INSTRUCTIONS },
    extraRequired: ["instructions"],
  }
);

const MCP_SUBSCRIPTION_BLOCK = composePaymentDescriptor(
  STRIPE_SUBSCRIPTION_DESCRIPTOR_PROPERTIES,
  STRIPE_SUBSCRIPTION_DESCRIPTOR_REQUIRED,
  {
    omit: ["type", "clientSecret", "customerId", "connectedAccountId"],
    extraProperties: {
      status: { type: "string" },
      currentPeriodEnd: { type: "number" },
      quantity: { type: "number" },
      discountPercent: { type: "number" },
    },
    extraRequired: ["status", "quantity"],
  }
);

function compile(subschema: JsonSchema) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(subschema);
}

// --- Route driving ------------------------------------------------------------

const ORDER = { id: "order-1", order_id: "order-1" };

// `satisfies` (not a Record annotation) keeps each entry's literal type so
// keyed access stays defined under noUncheckedIndexedAccess.
const RESULTS = {
  lightning: {
    kind: "lightning",
    order: ORDER as any,
    bolt11: "lnbc15u1p...",
    quoteId: "quote_1",
    amountSats: 1500,
    mintUrl: "https://mint.example",
    // Resolved from the real invoice by order-service; the route must pass it
    // through verbatim (a hardcoded offset here would mis-advertise expiry).
    expiresAt: "2030-01-01T01:00:00.000Z",
    pricingBlock: {},
  },
  cashu: {
    kind: "cashu",
    order: ORDER as any,
    tokenAmount: 1500,
    requiredAmount: 1500,
    change: 0,
    pricingBlock: {},
  },
  fiat: {
    kind: "fiat",
    order: ORDER as any,
    fiatOptions: ["Venmo @seller"],
    selectedMethod: "Venmo @seller",
    sellerContact: { name: "Seller", nip05: "seller@example.com" },
    amount: 12.5,
    currency: "usd",
    pricingBlock: {},
  },
  stripe: {
    kind: "stripe",
    order: ORDER as any,
    paymentIntentId: "pi_1",
    clientSecret: "pi_1_secret",
    connectedAccountId: "acct_1",
    amount: 12.5,
    currency: "usd",
    pricingBlock: {},
  },
  stripeNoConnectedAccount: {
    kind: "stripe",
    order: ORDER as any,
    paymentIntentId: "pi_2",
    clientSecret: "pi_2_secret",
    connectedAccountId: null,
    amount: 12.5,
    currency: "usd",
    pricingBlock: {},
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
  // (e.g. connectedAccountId: undefined) exactly as res.json serialization
  // would, so "optional" really means "absent on the wire".
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
  mockFormatOrderForResponse.mockImplementation((order: any) => ({
    id: order.id,
  }));
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore?.();
});

describe("MCP create-order payment descriptors ↔ shared UCP field contracts", () => {
  it("lightning 402 descriptor matches the shared lightning fields (+ MCP extras)", async () => {
    const { statusCode, body } = await postForResult(RESULTS.lightning);
    expect(statusCode).toBe(402);
    const validate = compile(MCP_LIGHTNING_PAYMENT);
    const ok: boolean = validate(body.payment);
    expect(ok ? true : JSON.stringify(validate.errors)).toBe(true);
  });

  it("lightning expiresAt is passed through from the engine, not recomputed", async () => {
    // Pins the fix for the hardcoded `Date.now() + 10 * 60 * 1000`: the wire
    // value must be exactly what order-service resolved from the invoice.
    const { body } = await postForResult(RESULTS.lightning);
    expect(body.payment.expiresAt).toBe(RESULTS.lightning.expiresAt);
  });

  it("cashu 201 descriptor matches the shared cashu fields exactly", async () => {
    const { statusCode, body } = await postForResult(RESULTS.cashu);
    expect(statusCode).toBe(201);
    const validate = compile(MCP_CASHU_PAYMENT);
    const ok: boolean = validate(body.payment);
    expect(ok ? true : JSON.stringify(validate.errors)).toBe(true);
  });

  it("fiat 402 descriptor matches the shared fiat fields (+ instructions)", async () => {
    const { statusCode, body } = await postForResult(RESULTS.fiat);
    expect(statusCode).toBe(402);
    const validate = compile(MCP_FIAT_PAYMENT);
    const ok: boolean = validate(body.payment);
    expect(ok ? true : JSON.stringify(validate.errors)).toBe(true);
  });

  it("stripe 402 descriptor matches the shared one-time fields (+ instructions)", async () => {
    const { statusCode, body } = await postForResult(RESULTS.stripe);
    expect(statusCode).toBe(402);
    const validate = compile(MCP_STRIPE_ONE_TIME_PAYMENT);
    const ok: boolean = validate(body.payment);
    expect(ok ? true : JSON.stringify(validate.errors)).toBe(true);
  });

  it("stripe 402 descriptor validates with no connected account (field absent)", async () => {
    const { statusCode, body } = await postForResult(
      RESULTS.stripeNoConnectedAccount
    );
    expect(statusCode).toBe(402);
    expect(body.payment).not.toHaveProperty("connectedAccountId");
    const validate = compile(MCP_STRIPE_ONE_TIME_PAYMENT);
    const ok: boolean = validate(body.payment);
    expect(ok ? true : JSON.stringify(validate.errors)).toBe(true);
  });

  it("stripe without a PaymentIntent returns payment:null (free-order arm)", async () => {
    const { statusCode, body } = await postForResult({
      ...(RESULTS.stripe as Extract<OrderFlowResult, { kind: "stripe" }>),
      paymentIntentId: null,
      clientSecret: null,
    });
    expect(statusCode).toBe(201);
    expect(body.payment).toBeNull();
  });

  it("subscription 402 splits the shared subscription fields across payment + subscription", async () => {
    const { statusCode, body } = await postForResult(RESULTS.subscription);
    expect(statusCode).toBe(402);
    for (const [label, subschema, descriptor] of [
      ["payment", MCP_SUBSCRIPTION_PAYMENT, body.payment],
      ["subscription", MCP_SUBSCRIPTION_BLOCK, body.subscription],
    ] as const) {
      const validate = compile(subschema);
      const ok: boolean = validate(descriptor);
      expect(
        ok
          ? true
          : `${label} half rejected: ${JSON.stringify(validate.errors)}`
      ).toBe(true);
    }
  });

  // --- Drift pins: one-sided renames must fail closed -------------------------

  it.each([
    [
      "lightning",
      MCP_LIGHTNING_PAYMENT,
      { bolt11: undefined, invoice: "lnbc1..." },
    ],
    [
      "lightning",
      MCP_LIGHTNING_PAYMENT,
      { quoteId: undefined, quote: "quote_1" },
    ],
    ["cashu", MCP_CASHU_PAYMENT, { change: undefined, changeAmount: 0 }],
    [
      "fiat",
      MCP_FIAT_PAYMENT,
      { availableMethods: undefined, methods: ["Venmo @seller"] },
    ],
    [
      "fiat",
      MCP_FIAT_PAYMENT,
      { sellerContact: undefined, contact: { name: "S", nip05: null } },
    ],
    [
      "stripe one-time",
      MCP_STRIPE_ONE_TIME_PAYMENT,
      { paymentIntentId: undefined, intentId: "pi_1" },
    ],
    [
      "stripe one-time",
      MCP_STRIPE_ONE_TIME_PAYMENT,
      { clientSecret: undefined, secret: "cs_1" },
    ],
    [
      "subscription payment",
      MCP_SUBSCRIPTION_PAYMENT,
      { customerId: undefined, customer: "cus_1" },
    ],
    [
      "subscription block",
      MCP_SUBSCRIPTION_BLOCK,
      { recurringAmount: undefined, amount: 10 },
    ],
  ])(
    "fails closed when a shared %s field is renamed in the route",
    async (resultKey, subschema, rename) => {
      const key = (
        resultKey === "subscription payment" || resultKey === "subscription block"
          ? "subscription"
          : resultKey === "stripe one-time"
            ? "stripe"
            : resultKey
      ) as keyof typeof RESULTS;
      const { body } = await postForResult(RESULTS[key]);
      const target =
        resultKey === "subscription block" ? body.subscription : body.payment;
      const drifted = JSON.parse(
        JSON.stringify({ ...target, ...(rename as Record<string, unknown>) })
      );
      const validate = compile(subschema);
      expect(validate(drifted)).toBe(false);
    }
  );

  it.each([
    ["lightning", MCP_LIGHTNING_PAYMENT],
    ["cashu", MCP_CASHU_PAYMENT],
    ["fiat", MCP_FIAT_PAYMENT],
    ["stripe", MCP_STRIPE_ONE_TIME_PAYMENT],
  ])(
    "rejects an unexpected extra field on the %s descriptor",
    async (key, subschema) => {
      const { body } = await postForResult(RESULTS[key as keyof typeof RESULTS]);
      const validate = compile(subschema);
      expect(validate({ ...body.payment, surpriseField: 1 })).toBe(false);
    }
  );
});
