/** @jest-environment node */

// Contract test: the advertised UCP checkout-session JSON Schema
// (pages/api/ucp/schemas/checkout-session.json.ts, linked from the discovery
// profile) must accept what formatCheckoutSession (utils/ucp/checkout-store.ts)
// actually emits — for every status and payment-method variant. The schema sets
// additionalProperties:true at the top level, so plain schema validation would
// NOT catch the mapper gaining or renaming a field; this test adds an explicit
// top-level allowlist check so the two cannot drift silently, plus enum parity
// for status/paymentMethod. Mirrors __tests__/utils/ucp/product-schema-contract.test.ts.

import type { NextApiRequest, NextApiResponse } from "next";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

import handler from "@/pages/api/ucp/schemas/checkout-session.json";
import { SITE_HOST, SITE_URL } from "@/utils/site-url";
import { formatCheckoutSession } from "@/utils/ucp/checkout-store";
import type { CheckoutSessionRow } from "@/utils/ucp/checkout-store";
import { CHECKOUT_STATUSES } from "@/utils/ucp/checkout-status";
import type { PaymentMethod } from "@/utils/ucp/order-service";

type JsonSchema = Record<string, any>;

jest.mock("@/utils/db/db-service", () => ({
  getDbPool: jest.fn(),
  withSchemaDdlLock: jest.fn(),
}));

function getSchema(): JsonSchema {
  let body: JsonSchema | undefined;
  const res = {
    setHeader: () => res,
    status: () => res,
    json: (payload: JsonSchema) => {
      body = payload;
      return res;
    },
    end: () => res,
  } as unknown as NextApiResponse;
  handler(
    { method: "GET", headers: { host: SITE_HOST } } as NextApiRequest,
    res
  );
  if (!body) throw new Error("schema handler did not emit a body");
  return body;
}

const BASE_ROW: CheckoutSessionRow = {
  id: "ucp_cs_test123",
  api_key_id: 1,
  buyer_pubkey: "aa".repeat(32),
  seller_pubkey: "bb".repeat(32),
  product_id: "30402:bb:raw-milk-gallon",
  mcp_order_id: "ord_123",
  status: "ready_for_complete",
  payment_method: "stripe",
  amount_total: "12.50",
  currency: "usd",
  request: {},
  // Real pricingBlock shape written by the order engine
  // (utils/ucp/order-service.ts buildQuote).
  quote: {
    unitPrice: 12,
    quantity: 1,
    subtotal: 12,
    shippingCost: 0.5,
    total: 12.5,
    currency: "usd",
  },
  payment: {
    method: "stripe",
    amount: 12.5,
    currency: "usd",
    paymentIntentId: "pi_123",
    clientSecret: "pi_123_secret",
    connectedAccountId: "acct_123",
  },
  messages: [
    { type: "session_created", text: "Checkout session created.", at: new Date(1_700_000_000_000).toISOString() },
    {
      type: "ready_for_complete",
      text: "Confirm the Stripe payment with the clientSecret to complete the order.",
      at: new Date(1_700_000_000_000).toISOString(),
      severity: "warning",
    },
  ],
  error: null,
  created_at: new Date(1_700_000_000_000).toISOString(),
  updated_at: new Date(1_700_000_060_000).toISOString(),
};

// Representative payment descriptor per method, matching describeResult() in
// pages/api/ucp/checkout/sessions.ts.
const PAYMENT_BY_METHOD: Record<PaymentMethod, Record<string, unknown>> = {
  stripe: BASE_ROW.payment,
  lightning: {
    method: "lightning",
    bolt11: "lnbc1...",
    quoteId: "quote_123",
    amount: 1500,
    currency: "sats",
    mintUrl: "https://mint.example",
    verifyUrl: "/api/mcp/verify-payment",
  },
  cashu: {
    method: "cashu",
    amount: 1500,
    required: 1500,
    change: 0,
    status: "paid",
  },
  fiat: {
    method: "fiat",
    selectedMethod: "Venmo @seller",
    availableMethods: ["Venmo @seller"],
    amount: 12.5,
    currency: "usd",
    // Engine shape: { name, nip05 } (utils/ucp/order-service.ts).
    sellerContact: { name: "Seller", nip05: "seller@example.com" },
  },
};

// The subscription arm of describeResult: payment_method stays "stripe" but the
// descriptor carries subscription fields, and the session has no order/quote.
const SUBSCRIPTION_PAYMENT: Record<string, unknown> = {
  method: "stripe",
  type: "subscription",
  subscriptionId: "sub_123",
  frequency: "monthly",
  clientSecret: "sub_123_secret",
  customerId: "cus_123",
  connectedAccountId: "acct_123",
  recurringAmount: 10,
  currency: "usd",
};

// One formatted session per payment method, plus one per lifecycle status,
// exercising the optional fields (orderId, quote, error, message severity).
function representativeSessions(): Array<ReturnType<typeof formatCheckoutSession>> {
  const sessions: Array<ReturnType<typeof formatCheckoutSession>> = [];
  const statusByMethod: Record<PaymentMethod, CheckoutSessionRow["status"]> = {
    stripe: "ready_for_complete",
    lightning: "ready_for_complete",
    cashu: "completed",
    fiat: "ready_for_complete",
  };
  for (const method of Object.keys(PAYMENT_BY_METHOD) as PaymentMethod[]) {
    sessions.push(
      formatCheckoutSession(
        {
          ...BASE_ROW,
          payment_method: method,
          status: statusByMethod[method],
          payment: PAYMENT_BY_METHOD[method],
        },
        SITE_URL
      )
    );
  }
  // Subscription checkout: no order row or quote yet, subscription descriptor.
  sessions.push(
    formatCheckoutSession(
      {
        ...BASE_ROW,
        payment_method: "stripe",
        status: "ready_for_complete",
        mcp_order_id: null,
        quote: null,
        payment: SUBSCRIPTION_PAYMENT,
      },
      SITE_URL
    )
  );
  for (const status of CHECKOUT_STATUSES) {
    sessions.push(
      formatCheckoutSession(
        {
          ...BASE_ROW,
          status,
          // Exercise the null/absent arms: no order yet, no quote, no payment.
          mcp_order_id: null,
          quote: null,
          payment: null,
          error: status === "requires_escalation" ? "Payment failed." : null,
          messages: [
            {
              type: status,
              text: `Session is ${status}.`,
              at: new Date(1_700_000_000_000).toISOString(),
              ...(status === "requires_escalation"
                ? { severity: "error" as const }
                : {}),
            },
          ],
        },
        SITE_URL
      )
    );
  }
  return sessions;
}

describe("UCP checkout-session JSON Schema ↔ formatCheckoutSession contract", () => {
  const schema = getSchema();
  const sessions = representativeSessions();

  it("produces fixtures that exercise the optional fields (non-vacuous)", () => {
    const allKeys = new Set(sessions.flatMap((s) => Object.keys(s)));
    for (const optional of ["orderId", "quote", "error"]) {
      expect(allKeys).toContain(optional);
    }
    expect(
      sessions.some((s) => s.messages.some((m) => m.severity))
    ).toBe(true);
    // And the null arms too, so "always-present" can't pass by accident.
    expect(sessions.some((s) => !("orderId" in s))).toBe(true);
    expect(sessions.some((s) => !("quote" in s))).toBe(true);
    expect(sessions.some((s) => s.payment === null)).toBe(true);
  });

  it("accepts every representative session under full schema validation", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    for (const session of sessions) {
      // Capture the label before validating: ajv's validate is a type
      // predicate, so using session in the failure branch would narrow it to
      // `never` under tsc.
      const label = `${session.status}/${session.paymentMethod}`;
      const ok: boolean = validate(session);
      expect(
        ok
          ? true
          : `schema rejected a ${label} session: ${ajv.errorsText(validate.errors)}`
      ).toBe(true);
    }
  });

  it("declares every top-level field the mapper can emit (additionalProperties:true would hide drift)", () => {
    const declared = schema.properties ?? {};
    for (const session of sessions) {
      for (const key of Object.keys(session)) {
        expect(declared).toHaveProperty(key);
      }
    }
  });

  it("emits every field the schema requires", () => {
    const required: string[] = schema.required ?? [];
    for (const session of sessions) {
      for (const key of required) {
        expect(session).toHaveProperty(key);
      }
    }
  });

  it("keeps the status enum in lockstep with the lifecycle source of truth", () => {
    expect(schema.properties?.status?.enum).toEqual([...CHECKOUT_STATUSES]);
    for (const session of sessions) {
      expect(schema.properties?.status?.enum).toContain(session.status);
    }
  });

  it("keeps the paymentMethod enum in lockstep with the order engine", () => {
    expect(schema.properties?.paymentMethod?.enum).toEqual([
      "stripe",
      "lightning",
      "cashu",
      "fiat",
    ]);
    for (const session of sessions) {
      expect(schema.properties?.paymentMethod?.enum).toContain(
        session.paymentMethod
      );
    }
  });

  // --- Payment-descriptor discrimination ---------------------------------
  // The payment subschema is self-contained (no $refs), so it can be compiled
  // on its own to validate the describeResult descriptors directly.

  function compileSubschema(subschema: JsonSchema) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    return ajv.compile(subschema);
  }

  it("discriminates the payment object by method with one branch per describeResult arm", () => {
    const payment = schema.properties?.payment;
    expect(payment?.allOf).toHaveLength(4);
    const methods = payment.allOf.map(
      (branch: JsonSchema) => branch.if?.properties?.method?.const
    );
    expect([...methods].sort()).toEqual(["cashu", "fiat", "lightning", "stripe"]);
  });

  it("accepts every describeResult payment descriptor under its discriminated branch", () => {
    const validatePayment = compileSubschema(schema.properties.payment);
    const descriptors: Array<[string, Record<string, unknown>]> = [
      ...Object.entries(PAYMENT_BY_METHOD),
      ["subscription", SUBSCRIPTION_PAYMENT],
    ];
    for (const [label, descriptor] of descriptors) {
      const ok: boolean = validatePayment(descriptor);
      expect(
        ok
          ? true
          : `payment subschema rejected the ${label} descriptor: ${JSON.stringify(validatePayment.errors)}`
      ).toBe(true);
    }
  });

  it("also accepts the nullable arms of the stripe descriptors", () => {
    const validatePayment = compileSubschema(schema.properties.payment);
    const oneTime: boolean = validatePayment({
      ...PAYMENT_BY_METHOD.stripe,
      paymentIntentId: null,
      clientSecret: null,
      connectedAccountId: null,
    });
    expect(oneTime ? true : JSON.stringify(validatePayment.errors)).toBe(true);
    // /api/stripe/create-subscription returns clientSecret:null when no
    // first-payment PaymentIntent is resolved; the descriptor carries it.
    const subNullSecret: boolean = validatePayment({
      ...SUBSCRIPTION_PAYMENT,
      clientSecret: null,
    });
    expect(
      subNullSecret ? true : JSON.stringify(validatePayment.errors)
    ).toBe(true);
  });

  it.each([
    ["lightning", { ...PAYMENT_BY_METHOD.lightning, bolt11: undefined, invoice: "lnbc1..." }],
    ["stripe one-time", { ...PAYMENT_BY_METHOD.stripe, paymentIntentId: undefined, intentId: "pi_123" }],
    ["cashu", { ...PAYMENT_BY_METHOD.cashu, change: undefined, changeAmount: 0 }],
    ["fiat", { ...PAYMENT_BY_METHOD.fiat, availableMethods: undefined, methods: ["Venmo"] }],
    [
      "subscription",
      { ...SUBSCRIPTION_PAYMENT, subscriptionId: undefined, subId: "sub_123" },
    ],
  ])(
    "fails closed when a field of the %s descriptor is renamed (drift)",
    (_label, descriptor) => {
      const validatePayment = compileSubschema(schema.properties.payment);
      // JSON round-trip drops the undefined placeholder keys, leaving the
      // renamed field in place of the real one.
      const ok: boolean = validatePayment(
        JSON.parse(JSON.stringify(descriptor))
      );
      expect(ok).toBe(false);
    }
  );

  it.each([
    ["lightning", { ...PAYMENT_BY_METHOD.lightning, surpriseField: 1 }],
    ["stripe one-time", { ...PAYMENT_BY_METHOD.stripe, surpriseField: 1 }],
    ["subscription", { ...SUBSCRIPTION_PAYMENT, surpriseField: 1 }],
    ["cashu", { ...PAYMENT_BY_METHOD.cashu, surpriseField: 1 }],
    ["fiat", { ...PAYMENT_BY_METHOD.fiat, surpriseField: 1 }],
  ])("rejects an unexpected extra field on the %s descriptor", (_l, descriptor) => {
    const validatePayment = compileSubschema(schema.properties.payment);
    expect(validatePayment(descriptor)).toBe(false);
  });

  // --- Quote shape ---------------------------------------------------------

  it("accepts the quote shapes the order engine writes", () => {
    const validateQuote = compileSubschema(schema.properties.quote);
    const quotes = [
      BASE_ROW.quote,
      {
        ...BASE_ROW.quote,
        discountPercentage: 10,
        discountedSubtotal: 10.8,
        selectedSpecs: { size: "gallon" },
      },
    ];
    for (const quote of quotes) {
      const ok: boolean = validateQuote(quote);
      expect(
        ok
          ? true
          : `quote subschema rejected an engine quote: ${JSON.stringify(validateQuote.errors)}`
      ).toBe(true);
    }
  });

  it.each([
    ["renamed total", { ...BASE_ROW.quote, total: undefined, totalAmount: 12.5 }],
    ["extra field", { ...BASE_ROW.quote, surpriseField: 1 }],
  ])("rejects a quote with %s (drift)", (_label, quote) => {
    const validateQuote = compileSubschema(schema.properties.quote);
    expect(validateQuote(JSON.parse(JSON.stringify(quote)))).toBe(false);
  });
});
