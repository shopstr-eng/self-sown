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
import openApiHandler from "@/pages/api/openapi.json";
import { SITE_HOST, SITE_URL } from "@/utils/site-url";
import {
  formatCheckoutSession,
  formatEphemeralCheckoutSession,
} from "@/utils/ucp/checkout-store";
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
  code: null,
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

// The UNPERSISTED response envelopes POST /api/ucp/checkout/sessions can
// emit, built through the same helper the route uses so the test can't drift
// from the wire shape:
//  - persist-failure fallback (201): the order was created but the session row
//    was not, so the body carries the full payment descriptor + a `warning`.
//  - escalation persist-failure fallback (200): a fail-closed engine error
//    (e.g. no live exchange rate) means NO order exists — no amount/payment
//    descriptor, but a severity-tagged `error` + machine-readable `code` —
//    and the escalation row itself could not be saved, so a `warning` too.
const FALLBACK_ENVELOPE = formatEphemeralCheckoutSession(
  {
    id: "ucp_cs_fallback123",
    status: "ready_for_complete",
    buyerPubkey: BASE_ROW.buyer_pubkey,
    sellerPubkey: BASE_ROW.seller_pubkey,
    productId: BASE_ROW.product_id,
    mcpOrderId: BASE_ROW.mcp_order_id,
    paymentMethod: "stripe",
    amountTotal: 12.5,
    currency: "usd",
    payment: BASE_ROW.payment,
    messages: BASE_ROW.messages!,
    warning: "Session record could not be persisted; payment is still valid.",
  },
  SITE_URL
);

const ESCALATION_ENVELOPE = formatEphemeralCheckoutSession(
  {
    id: "ucp_cs_escalation123",
    status: "requires_escalation",
    buyerPubkey: BASE_ROW.buyer_pubkey,
    sellerPubkey: BASE_ROW.seller_pubkey,
    productId: BASE_ROW.product_id,
    paymentMethod: "lightning",
    payment: null,
    currency: "USD",
    messages: [
      {
        type: "session_created",
        text: "Checkout session created.",
        at: new Date(1_700_000_000_000).toISOString(),
      },
      {
        type: "requires_escalation",
        text: "This product is priced in USD and can't be settled in Bitcoin without a live exchange rate.",
        at: new Date(1_700_000_000_000).toISOString(),
        severity: "error" as const,
      },
    ],
    error:
      "This product is priced in USD and can't be settled in Bitcoin without a live exchange rate.",
    code: "exchange_rate_unavailable",
  },
  SITE_URL
);

// A PERSISTED session reconciled to requires_escalation (GET …/sessions/[id]
// or POST …/complete finds the order's payment failed, or a legacy row
// migrated from the old 'failed' status): it keeps the order's fields and may
// carry NO error (updateCheckoutSessionStatus only recently began stamping
// one; legacy rows never have it). This is the production shape the schema
// must not reject.
const PERSISTED_ESCALATION = formatCheckoutSession(
  {
    ...BASE_ROW,
    status: "requires_escalation",
    error: null,
    messages: [
      ...BASE_ROW.messages!,
      {
        type: "requires_escalation",
        text: "Payment failed; this needs attention.",
        at: new Date(1_700_000_060_000).toISOString(),
        severity: "error" as const,
      },
    ],
  },
  SITE_URL
);

// A PERSISTED PRE-ORDER escalation session (the POST escalation branch now
// saves a row): no order id, no amount (a 0 total would be a lie), but the
// engine's error + machine-readable code survive on the row so the self link
// resolves to an explanation.
const PERSISTED_PRE_ORDER_ESCALATION = formatCheckoutSession(
  {
    ...BASE_ROW,
    status: "requires_escalation",
    mcp_order_id: null,
    quote: null,
    payment: null,
    amount_total: "0.00",
    error:
      "This product is priced in USD and can't be settled in Bitcoin without a live exchange rate.",
    code: "exchange_rate_unavailable",
    messages: [
      {
        type: "session_created",
        text: "Checkout session created.",
        at: new Date(1_700_000_000_000).toISOString(),
      },
      {
        type: "requires_escalation",
        text: "This product is priced in USD and can't be settled in Bitcoin without a live exchange rate.",
        at: new Date(1_700_000_010_000).toISOString(),
        severity: "error" as const,
      },
    ],
  },
  SITE_URL
);

describe("UCP checkout-session JSON Schema ↔ formatCheckoutSession contract", () => {
  const schema = getSchema();
  const sessions = representativeSessions();
  const envelopes = [
    ["persist-failure fallback", FALLBACK_ENVELOPE],
    ["requires_escalation (pre-order, no orderId)", ESCALATION_ENVELOPE],
    ["requires_escalation (persisted, orderId, no error)", PERSISTED_ESCALATION],
    [
      "requires_escalation (persisted, pre-order, no orderId, error+code)",
      PERSISTED_PRE_ORDER_ESCALATION,
    ],
  ] as const;

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

  it("accepts the fallback and escalation envelopes under full schema validation", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    for (const [label, envelope] of envelopes) {
      const ok: boolean = validate(envelope);
      expect(
        ok
          ? true
          : `schema rejected the ${label} envelope: ${ajv.errorsText(validate.errors)}`
      ).toBe(true);
    }
  });

  it("envelope fixtures exercise the conditional branches (non-vacuous)", () => {
    // Fallback: a normal (non-escalation) session WITH the optional warning.
    expect(FALLBACK_ENVELOPE).toHaveProperty("warning");
    expect(FALLBACK_ENVELOPE).toHaveProperty("amount");
    expect(FALLBACK_ENVELOPE).toHaveProperty("payment");
    // Escalation: no order → no amount/payment descriptor; error + code set.
    expect(ESCALATION_ENVELOPE.status).toBe("requires_escalation");
    expect(ESCALATION_ENVELOPE).not.toHaveProperty("amount");
    expect(ESCALATION_ENVELOPE.payment).toBeNull();
    expect(ESCALATION_ENVELOPE).toHaveProperty("error");
    expect(ESCALATION_ENVELOPE).toHaveProperty("code");
    // Persisted pre-order escalation: same shape from the row formatter — the
    // reason (error + code) survives, and no fake 0 total is reported.
    expect(PERSISTED_PRE_ORDER_ESCALATION).not.toHaveProperty("orderId");
    expect(PERSISTED_PRE_ORDER_ESCALATION).not.toHaveProperty("amount");
    expect(PERSISTED_PRE_ORDER_ESCALATION).toHaveProperty("error");
    expect(PERSISTED_PRE_ORDER_ESCALATION.code).toBe(
      "exchange_rate_unavailable"
    );
  });

  it("requires error only on pre-order escalation; order fields otherwise", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    // A pre-order escalation envelope (no orderId) WITHOUT its error is not
    // actionable — reject.
    const { error: _e, ...escalationNoError } = ESCALATION_ENVELOPE as Record<
      string,
      unknown
    >;
    expect(validate(escalationNoError)).toBe(false);
    // A persisted escalation keeps its order fields; dropping them is a lie —
    // reject even though the error explanation is present.
    const { amount: _a, ...persistedNoAmount } = PERSISTED_ESCALATION as Record<
      string,
      unknown
    >;
    expect(validate({ ...persistedNoAmount, error: "Payment failed." })).toBe(
      false
    );
    // A non-escalation session missing its total/descriptor is a lie — reject.
    const { amount: _a2, ...fallbackNoAmount } = FALLBACK_ENVELOPE as Record<
      string,
      unknown
    >;
    expect(validate(fallbackNoAmount)).toBe(false);
    // A pre-order escalation MAY still carry amount/currency (optional, not
    // banned — the route emits the engine's currency when known).
    const ok: boolean = validate({ ...ESCALATION_ENVELOPE, amount: 12.5 });
    expect(ok ? true : ajv.errorsText(validate.errors)).toBe(true);
  });

  it("declares every top-level field the mapper can emit (additionalProperties:true would hide drift)", () => {
    const declared = schema.properties ?? {};
    const bodies = [...sessions, ...envelopes.map(([, e]) => e)];
    for (const session of bodies) {
      for (const key of Object.keys(session)) {
        expect(declared).toHaveProperty(key);
      }
    }
  });

  it("emits every field the schema requires", () => {
    const required: string[] = schema.required ?? [];
    const bodies = [...sessions, ...envelopes.map(([, e]) => e)];
    for (const session of bodies) {
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

// The checkout-session shape is described TWICE: the canonical JSON Schema
// above and a condensed UcpCheckoutSession component in the published OpenAPI
// document (pages/api/openapi.json.ts). The condensed copy is allowed to be a
// subset (it is a summary), but its required list must not promise fields the
// canonical schema does not require, and it must not name properties the
// canonical schema does not declare — otherwise agents reading the OpenAPI
// doc learn a shape that never exists on the wire.
describe("condensed OpenAPI UcpCheckoutSession ↔ canonical JSON Schema parity", () => {
  function loadCondensedComponent(): JsonSchema {
    let payload: JsonSchema | undefined;
    const res = {
      setHeader: () => res,
      status: (code: number) => {
        expect(code).toBe(200);
        return res;
      },
      json: (body: JsonSchema) => {
        payload = body;
        return res;
      },
    } as unknown as NextApiResponse;
    openApiHandler({} as NextApiRequest, res);
    const component = payload?.components?.schemas?.UcpCheckoutSession;
    if (!component) {
      throw new Error("openapi.json is missing the UcpCheckoutSession component");
    }
    return component;
  }

  const schema = getSchema();
  const condensed = loadCondensedComponent();

  it("exercises real fields on both copies (non-vacuous)", () => {
    expect(condensed.required.length).toBeGreaterThan(0);
    expect(schema.required.length).toBeGreaterThan(condensed.required.length);
    expect(Object.keys(condensed.properties).length).toBeGreaterThan(10);
    expect(Object.keys(schema.properties).length).toBeGreaterThan(
      Object.keys(condensed.properties).length
    );
  });

  it("keeps the condensed required list a subset of the canonical base required list", () => {
    // A condensed-required field the canonical schema does not require would
    // tell agents a field is always present when it is not. (The canonical
    // allOf conditionals add status-dependent requirements on top of the base
    // list; the condensed view may legitimately omit those.)
    for (const field of condensed.required) {
      expect(schema.required).toContain(field);
    }
  });

  it("declares every condensed property in the canonical schema (rename/add drift)", () => {
    // Catches either copy renaming or adding a field without the other: a
    // renamed canonical field leaves the condensed name dangling, and a
    // condensed-only field is a plain invention. Canonical-only additions
    // (e.g. code, warning) are allowed — the view is deliberately condensed.
    for (const name of Object.keys(condensed.properties)) {
      expect(schema.properties).toHaveProperty(name);
    }
  });

  it("keeps the status enum identical across both copies", () => {
    expect(condensed.properties.status.enum).toEqual(
      schema.properties.status.enum
    );
  });

  it("keeps the paymentMethod enum identical across both copies", () => {
    expect(condensed.properties.paymentMethod.enum).toEqual(
      schema.properties.paymentMethod.enum
    );
  });
});
