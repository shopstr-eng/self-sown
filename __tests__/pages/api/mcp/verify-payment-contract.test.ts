/** @jest-environment node */

/**
 * Response contract for POST /api/mcp/verify-payment.
 *
 * This is the endpoint agent clients poll after create-order hands them a
 * Lightning invoice, but its response (envelope + lightning payment block) is
 * hand-built in the route with no schema guarding it — a rename there
 * (status → state, quoteId → quote, orderId → order, …) would silently break
 * every polling agent while create-order's own contract test kept passing.
 *
 * This test drives the REAL handler through each 200 arm, captures the wire
 * body, and validates it closed:
 *  - the envelope (success/status/message/orderId[/payment]) against a pinned
 *    MCP envelope schema, and
 *  - the nested lightning `payment` block against an MCP-flavored composition
 *    of the SAME shared field contracts (utils/ucp/payment-descriptor-schema.ts)
 *    that the UCP schema and create-order descriptors are built from — rename
 *    a shared field (amount, currency, quoteId, mintUrl) in the route OR in
 *    the shared module and this test fails.
 */

import type { NextApiRequest, NextApiResponse } from "next";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

import {
  composePaymentDescriptor,
  LIGHTNING_DESCRIPTOR_PROPERTIES,
  LIGHTNING_DESCRIPTOR_REQUIRED,
  type JsonSchema,
} from "@/utils/ucp/payment-descriptor-schema";

const mockApplyRateLimit = jest.fn();
const mockAuthenticateRequest = jest.fn();
const mockInitializeApiKeysTable = jest.fn();
const mockGetMcpOrder = jest.fn();
const mockUpdateMcpOrderPayment = jest.fn();
const mockCheckMintQuoteBolt11 = jest.fn();
const mockLoadMint = jest.fn();

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: (...args: any[]) => mockApplyRateLimit(...args),
}));

jest.mock("@/utils/mcp/auth", () => ({
  authenticateRequest: (...args: any[]) => mockAuthenticateRequest(...args),
  initializeApiKeysTable: (...args: any[]) =>
    mockInitializeApiKeysTable(...args),
}));

jest.mock("@/utils/mcp/metrics", () => ({ recordRequest: jest.fn() }));

jest.mock("@/mcp/tools/purchase-tools", () => ({
  getMcpOrder: (...args: any[]) => mockGetMcpOrder(...args),
  updateMcpOrderPayment: (...args: any[]) =>
    mockUpdateMcpOrderPayment(...args),
}));

// verify-payment imports pendingLightningPayments from the sibling route;
// stub the module so this suite controls the map (seeded via the mocked
// import below) and never pulls in the order-service graph. The Map must be
// created inline in the factory: a module-scope const is still in its TDZ
// when the factory runs (SWC hoists requires above const initializers).
jest.mock("@/pages/api/mcp/create-order", () => ({
  pendingLightningPayments: new Map<string, Record<string, unknown>>(),
}));

jest.mock("@/utils/db/inventory-service", () => ({
  deductStock: jest.fn(),
}));

jest.mock("@/utils/db/db-service", () => ({
  markDiscountCodeUsed: jest.fn(),
  // getDbPool is called at module scope by real utils/db/* modules; a mock
  // without it kills the whole suite at import time.
  getDbPool: jest.fn(),
}));

jest.mock("@cashu/cashu-ts", () => ({
  Mint: jest.fn(),
  Wallet: jest.fn().mockImplementation(() => ({
    loadMint: mockLoadMint,
    checkMintQuoteBolt11: mockCheckMintQuoteBolt11,
  })),
  MintQuoteState: { UNPAID: "UNPAID", PAID: "PAID", ISSUED: "ISSUED" },
}));

import verifyPaymentHandler from "@/pages/api/mcp/verify-payment";
// Mocked above — importing it here hands us the same Map instance the route
// reads, so tests can seed/clear pending payments.
import { pendingLightningPayments } from "@/pages/api/mcp/create-order";

const pendingMap = pendingLightningPayments as unknown as Map<
  string,
  Record<string, unknown>
>;

// --- MCP verify-payment contract --------------------------------------------
// The nested lightning payment block reuses the shared lightning field
// contract verbatim: bolt11 (already paid or about to be) and verifyUrl (this
// route IS the verify endpoint) are omitted; mintUrl is emitted only while
// unpaid (paid arm drops it); the `method` discriminator is added. Anything
// NOT listed must match the shared field contract exactly.

const MCP_VERIFY_LIGHTNING_PAYMENT = composePaymentDescriptor(
  LIGHTNING_DESCRIPTOR_PROPERTIES,
  LIGHTNING_DESCRIPTOR_REQUIRED,
  {
    method: "lightning",
    omit: ["bolt11", "verifyUrl"],
    optional: ["mintUrl"],
  }
);

// The envelope is MCP-specific (no shared counterpart), so it is pinned here
// closed: an agent polls `status` and correlates by `orderId`, and the exact
// status vocabulary is part of the wire contract.
function envelopeSchema({ withPayment }: { withPayment: boolean }): JsonSchema {
  return {
    type: "object",
    properties: {
      success: { const: true },
      status: { enum: ["paid", "unpaid", "pending_seller_confirmation"] },
      message: { type: "string" },
      orderId: { type: "string" },
      ...(withPayment ? { payment: MCP_VERIFY_LIGHTNING_PAYMENT } : {}),
    },
    required: [
      "success",
      "status",
      "message",
      "orderId",
      ...(withPayment ? ["payment"] : []),
    ],
    additionalProperties: false,
  };
}

// The "no pending lightning payment" 400 is part of the polling contract too:
// agents must keep seeing { error, orderId } and nothing else.
const NO_PENDING_ERROR = {
  type: "object",
  properties: {
    error: { type: "string" },
    orderId: { type: "string" },
  },
  required: ["error", "orderId"],
  additionalProperties: false,
} as const;

function compile(subschema: JsonSchema) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(subschema);
}

// --- Route driving ------------------------------------------------------------

const BUYER_PK = "buyer-pk";
const SELLER_PK = "seller-pk";
const ORDER = {
  id: "order-1",
  order_id: "order-1",
  buyer_pubkey: BUYER_PK,
  seller_pubkey: SELLER_PK,
  payment_status: "unpaid",
  payment_intent_id: null,
};

const PENDING = {
  quote: "quote_1",
  mintUrl: "https://mint.example",
  amount: 1500,
  orderId: "order-1",
  productId: "product-1",
  quantity: 1,
  inventoryVariantKey: "_default",
  sellerPubkey: SELLER_PK,
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

async function postVerify(
  order: Record<string, unknown> | null,
  {
    pending,
    quoteState,
  }: { pending?: Record<string, unknown>; quoteState?: string } = {}
) {
  mockGetMcpOrder.mockResolvedValue(order);
  pendingMap.clear();
  if (pending) pendingMap.set("order-1", pending);
  if (quoteState) mockCheckMintQuoteBolt11.mockResolvedValue({ state: quoteState });
  const res = createResponse();
  await verifyPaymentHandler(
    {
      method: "POST",
      headers: {},
      query: {},
      body: { orderId: "order-1" },
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

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  pendingMap.clear();
  mockApplyRateLimit.mockResolvedValue(true);
  mockInitializeApiKeysTable.mockResolvedValue(undefined);
  mockAuthenticateRequest.mockResolvedValue({ id: 7, pubkey: BUYER_PK });
  mockLoadMint.mockResolvedValue(undefined);
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore?.();
});

describe("MCP verify-payment response contract", () => {
  it("already-paid order: closed envelope, status 'paid', no payment block", async () => {
    const { statusCode, body } = await postVerify({
      ...ORDER,
      payment_status: "paid",
    });
    expect(statusCode).toBe(200);
    const validate = compile(envelopeSchema({ withPayment: false }));
    const ok: boolean = validate(body);
    expect(ok ? true : JSON.stringify(validate.errors)).toBe(true);
    expect(body.status).toBe("paid");
  });

  it("fiat order awaiting seller confirmation: closed envelope, no payment block", async () => {
    const { statusCode, body } = await postVerify({
      ...ORDER,
      payment_intent_id: "fiat_abc123",
    });
    expect(statusCode).toBe(200);
    const validate = compile(envelopeSchema({ withPayment: false }));
    const ok: boolean = validate(body);
    expect(ok ? true : JSON.stringify(validate.errors)).toBe(true);
    expect(body.status).toBe("pending_seller_confirmation");
  });

  it("no pending payment, non-fiat: closed { error, orderId } 400 body", async () => {
    const { statusCode, body } = await postVerify(ORDER);
    expect(statusCode).toBe(400);
    const validate = compile(NO_PENDING_ERROR);
    const ok: boolean = validate(body);
    expect(ok ? true : JSON.stringify(validate.errors)).toBe(true);
  });

  it("lightning settled: envelope + payment block match the shared lightning fields", async () => {
    const { statusCode, body } = await postVerify(ORDER, {
      pending: PENDING,
      quoteState: "PAID",
    });
    expect(statusCode).toBe(200);
    expect(body.status).toBe("paid");
    const validate = compile(envelopeSchema({ withPayment: true }));
    const ok: boolean = validate(body);
    expect(ok ? true : JSON.stringify(validate.errors)).toBe(true);
    // Settled arm drops mintUrl (only the unpaid arm tells the agent where
    // the invoice's mint is) — an extra-field pin the optional slot allows.
    expect(body.payment).not.toHaveProperty("mintUrl");
    expect(mockUpdateMcpOrderPayment).toHaveBeenCalledWith(
      "order-1",
      "ln_quote_1",
      "paid"
    );
  });

  it("lightning unpaid: payment block matches the shared lightning fields (mintUrl present)", async () => {
    const { statusCode, body } = await postVerify(ORDER, {
      pending: PENDING,
      quoteState: "UNPAID",
    });
    expect(statusCode).toBe(200);
    expect(body.status).toBe("unpaid");
    const validate = compile(envelopeSchema({ withPayment: true }));
    const ok: boolean = validate(body);
    expect(ok ? true : JSON.stringify(validate.errors)).toBe(true);
    expect(body.payment).toHaveProperty("mintUrl", PENDING.mintUrl);
    expect(mockUpdateMcpOrderPayment).not.toHaveBeenCalled();
  });

  // --- Drift pins: one-sided renames must fail closed -------------------------

  it.each([
    ["status", "state", "paid"],
    ["orderId", "order", "order-1"],
    ["success", "ok", true],
    ["message", "detail", "Payment has not been received yet. Please pay the invoice."],
  ])(
    "fails closed when envelope field %s is renamed in the route",
    async (from, to, value) => {
      const { body } = await postVerify(ORDER, {
        pending: PENDING,
        quoteState: "UNPAID",
      });
      const drifted = JSON.parse(
        JSON.stringify({ ...body, [from]: undefined, [to]: value })
      );
      const validate = compile(envelopeSchema({ withPayment: true }));
      expect(validate(drifted)).toBe(false);
    }
  );

  it.each([
    ["quoteId", "quote", "quote_1"],
    ["amount", "amountSats", 1500],
    ["currency", "unit", "sats"],
    ["mintUrl", "mint", "https://mint.example"],
    ["method", "type", "lightning"],
  ])(
    "fails closed when shared lightning payment field %s is renamed on either side",
    async (from, to, value) => {
      const { body } = await postVerify(ORDER, {
        pending: PENDING,
        quoteState: "UNPAID",
      });
      const drifted = JSON.parse(
        JSON.stringify({
          ...body,
          payment: { ...body.payment, [from]: undefined, [to]: value },
        })
      );
      const validate = compile(envelopeSchema({ withPayment: true }));
      expect(validate(drifted)).toBe(false);
    }
  );

  it("rejects an unexpected extra field on the envelope and on the payment block", async () => {
    const { body } = await postVerify(ORDER, {
      pending: PENDING,
      quoteState: "UNPAID",
    });
    const validate = compile(envelopeSchema({ withPayment: true }));
    expect(validate({ ...body, surpriseField: 1 })).toBe(false);
    expect(
      validate({ ...body, payment: { ...body.payment, surpriseField: 1 } })
    ).toBe(false);
  });
});
