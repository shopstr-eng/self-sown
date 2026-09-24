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
import { isSchemaEmail } from "@/utils/ucp/email-format";
import { VALID_METHODS } from "@/utils/ucp/order-service";

const mockApplyRateLimit = jest.fn();
const mockAuthenticateRequest = jest.fn();
const mockInitializeApiKeysTable = jest.fn();
const mockResolveHostScope = jest.fn();
const mockFetchAllProductsFromDb = jest.fn();
const mockFetchAllProfilesFromDb = jest.fn();
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
  // The envelope tests below validate REAL route responses against the
  // published session schema, so the ephemeral-envelope helpers must be the
  // production ones (the mocked makeMessage above used to drop `at`, which the
  // schema requires). Only the DB-touching pieces stay stubbed.
  const actual = jest.requireActual("@/utils/ucp/checkout-store");
  return {
    decodeVariantId: jest.fn(() => ({
      ok: false,
      error: "no variants in test",
    })),
    // The escalation test below validates the REAL persisted-session body
    // against the published schema, so the row formatter must be the
    // production one; the insert mock maps the input into a row it can read.
    formatCheckoutSession: actual.formatCheckoutSession,
    formatEphemeralCheckoutSession: actual.formatEphemeralCheckoutSession,
    generateCheckoutSessionId: actual.generateCheckoutSessionId,
    initCheckoutSessionsTable: jest.fn(() => Promise.resolve()),
    insertCheckoutSession: (...args: any[]) =>
      mockInsertCheckoutSession(...args),
    listCheckoutSessions: jest.fn(),
    makeMessage: actual.makeMessage,
  };
});

// NOTE: @/utils/ucp/order-service is intentionally NOT mocked — the real
// engine runs so the quantity bounds under parity test are the production
// guards themselves.

// Handlers under test (imported AFTER the mocks above).
import checkoutSessionsHandler from "@/pages/api/ucp/checkout/sessions";
import checkoutSessionCreateSchemaHandler from "@/pages/api/ucp/schemas/checkout-session-create.json";
import checkoutSessionSchemaHandler from "@/pages/api/ucp/schemas/checkout-session.json";

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
  // Seller profile with a fiat rail so the "fiat" paymentMethod case below can
  // complete the real engine's fiat branch without a network call.
  mockFetchAllProfilesFromDb.mockResolvedValue([
    {
      pubkey: "seller-pk",
      kind: 0,
      created_at: 1,
      content: JSON.stringify({ fiat_options: ["cash"] }),
    },
  ]);
  // A realistically parsed product so the real engine can price a valid order.
  mockParseTags.mockReturnValue({
    pubkey: "seller-pk",
    title: "Test Product",
    price: 30,
    currency: "USD",
  });
  // Echo the insert input back as the snake_case row the real
  // formatCheckoutSession reads, so route responses stay schema-shaped.
  mockInsertCheckoutSession.mockImplementation(async (input: any) => ({
    id: input.id,
    api_key_id: input.apiKeyId ?? null,
    buyer_pubkey: input.buyerPubkey,
    seller_pubkey: input.sellerPubkey,
    product_id: input.productId,
    mcp_order_id: input.mcpOrderId ?? null,
    status: input.status,
    payment_method: input.paymentMethod,
    amount_total: String(input.amountTotal ?? 0),
    currency: input.currency,
    request: input.request ?? null,
    quote: input.quote ?? null,
    payment: input.payment ?? null,
    messages: input.messages ?? [],
    error: input.error ?? null,
    code: input.code ?? null,
    created_at: new Date(1_700_000_000_000).toISOString(),
    updated_at: new Date(1_700_000_000_000).toISOString(),
  }));
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
    ["a stripe paymentMethod", { productId: "p1", paymentMethod: "stripe" }],
    [
      "a fiat paymentMethod",
      { productId: "p1", paymentMethod: "fiat", fiatMethod: "cash" },
    ],
    [
      "a well-formed buyerEmail",
      { productId: "p1", buyerEmail: "buyer@example.com" },
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
    [
      "an unknown paymentMethod",
      { productId: "p1", paymentMethod: "venmo" },
    ],
    ["a non-string paymentMethod", { productId: "p1", paymentMethod: 7 }],
    ["an empty-string paymentMethod", { productId: "p1", paymentMethod: "" }],
    [
      "a malformed buyerEmail",
      { productId: "p1", buyerEmail: "not-an-email" },
    ],
    ["a non-string buyerEmail", { productId: "p1", buyerEmail: 42 }],
    ["a null buyerEmail", { productId: "p1", buyerEmail: null }],
    // These pass a loose `[^@]+@[^@]+` check but are rejected by the schema's
    // ajv-formats `email` format — the route must agree with the schema.
    ["a dotless-domain buyerEmail", { productId: "p1", buyerEmail: "a@b" }],
    [
      "a double-dot buyerEmail",
      { productId: "p1", buyerEmail: "a..b@example.com" },
    ],
    [
      "a leading-dot buyerEmail",
      { productId: "p1", buyerEmail: ".a@example.com" },
    ],
    [
      "a leading-hyphen-domain buyerEmail",
      { productId: "p1", buyerEmail: "a@-x.com" },
    ],
  ];

  // The route cannot import ajv-formats (a devDependency), so
  // utils/ucp/email-format.ts replicates its `email` regex. Pin byte-level
  // equivalence against a real ajv compile so an ajv-formats upgrade that
  // changes the format fails here instead of silently drifting the route
  // away from the published schema.
  it("route email check agrees with ajv-formats on a battery of addresses", async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validateEmail = ajv.compile({
      type: "object",
      properties: { buyerEmail: { type: "string", format: "email" } },
    });
    const addresses = [
      "buyer@example.com",
      "a.b+c-d_e@f-g.example.co.uk",
      "not-an-email",
      "a@b",
      "a@example",
      "a..b@example.com",
      ".a@example.com",
      "a.@example.com",
      "a@-x.com",
      "a@x-.com",
      "a b@c.com",
      "a@@b.com",
      "@example.com",
      "a@",
      "",
    ];
    for (const email of addresses) {
      expect(isSchemaEmail(email)).toBe(validateEmail({ buyerEmail: email }));
    }
    // ajv's format keyword ignores non-strings (the type keyword owns those);
    // the route helper must still reject them so a typed `123` never
    // reaches receipt_email.
    expect(isSchemaEmail(123)).toBe(false);
    expect(isSchemaEmail(null)).toBe(false);
  });

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

describe("published schema keeps up with the fields the route actually reads", () => {
  // Drift guard: the fixed body lists above only prove parity for fields this
  // suite already knows about. If handleCreate starts reading a NEW request
  // field (or renames one) without the published schema being updated, nothing
  // above fails — agent clients build requests from the schema and silently
  // lose the field. The proxy below records every property the route reads off
  // the POST body so the schema's declared property set and the route's actual
  // read set cannot drift in EITHER direction.
  it("declares every request-body field handleCreate reads (proxy probe)", async () => {
    const schema = await fetchPublishedSchema();
    const declared = Object.keys(schema.properties ?? {});

    const accessed = new Set<string>();
    const body = new Proxy(
      {
        productId: "p1",
        quantity: 2,
        paymentMethod: "stripe",
        buyerEmail: "buyer@example.com",
      } as Record<string, unknown>,
      {
        get(target, prop, receiver) {
          if (typeof prop === "string") accessed.add(prop);
          return Reflect.get(target, prop, receiver);
        },
      }
    );

    const res = await postToRoute(body);
    // Non-vacuous: the probe must drive the FULL create path to a 201, or an
    // early 4xx short-circuit could hide every field read after it.
    expect(res.statusCode).toBe(201);
    expect(mockCreateMcpOrder).toHaveBeenCalled();
    // The probe must actually have observed reads, not passed on an empty set.
    expect(accessed.size).toBeGreaterThan(0);

    // Route reads a field the schema does not declare → clients never send it.
    for (const key of accessed) {
      expect(declared).toContain(key);
    }
    // Schema declares a field the route never reads → dead documented field
    // (renamed away in the route, or never wired). Both directions must hold.
    for (const key of declared) {
      expect(accessed).toContain(key);
    }
  });

  it("enforces every field the schema marks required", async () => {
    const schema = await fetchPublishedSchema();
    const required: string[] = schema.required ?? [];
    expect(required.length).toBeGreaterThan(0);

    // Derive a schema-valid value for each required field so the baseline
    // contains ALL of them — otherwise, once a second field becomes required
    // and is enforced, its absence could mask missing enforcement of the
    // others (every iteration would 400 for the wrong reason).
    const validValueFor = (field: string): unknown => {
      if (field === "productId") return "p1"; // the mocked catalog product id
      const prop = schema.properties?.[field] ?? {};
      if (prop.format === "email") return "buyer@example.com";
      if (Array.isArray(prop.enum)) return prop.enum[0];
      if (prop.type === "integer" || prop.type === "number") {
        return typeof prop.minimum === "number" ? prop.minimum : 1;
      }
      if (prop.type === "object") return {};
      return "x";
    };
    const baseline: Record<string, unknown> = {};
    for (const field of required) baseline[field] = validValueFor(field);

    // Non-vacuous: the complete baseline must genuinely reach the full create
    // path, or every per-field 400 below could come from some OTHER defect.
    const baselineRes = await postToRoute({ ...baseline });
    expect(baselineRes.statusCode).toBe(201);
    expect(mockCreateMcpOrder).toHaveBeenCalled();

    for (const field of required) {
      const body = { ...baseline };
      delete body[field];
      const res = await postToRoute(body);
      // A schema-required field the route does not enforce would be accepted
      // here, publishing a contract the API doesn't actually keep.
      expect(res.statusCode).toBe(400);
      // The rejection must name the missing field, so an agent client can fix
      // its request without guessing which required field it omitted.
      expect(JSON.stringify(res.body)).toContain(field);
    }
  });

  it("advertises exactly the paymentMethod enum the order engine enforces", async () => {
    const schema = await fetchPublishedSchema();
    // VALID_METHODS comes from the REAL order engine (unmocked in this file),
    // so adding a method to the engine without republishing the schema fails.
    expect(schema.properties?.paymentMethod?.enum).toEqual([...VALID_METHODS]);
  });
});

describe("POST response envelopes validate against the published session schema", () => {
  // The 201 persist-failure fallback and the 200 requires_escalation envelope
  // (persisted, plus its own persist-failure fallback) are the responses
  // handleCreate emits on the recoverable paths — each must still validate
  // against the session schema the discovery profile advertises, or
  // machine-validating agent clients reject them.

  async function compileSessionSchema() {
    const res = createResponse();
    await checkoutSessionSchemaHandler(
      { method: "GET", headers: {} } as unknown as NextApiRequest,
      res as unknown as NextApiResponse
    );
    expect(res.statusCode).toBe(200);
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    return ajv.compile(res.body as Record<string, any>);
  }

  it("200 requires_escalation envelope (fail-closed sats pricing) validates and persists", async () => {
    const validate = await compileSessionSchema();
    // A lightning payment on a USD-priced product trips the engine's
    // fail-closed conversion guard (no live exchange rate in the charge
    // path), which the route surfaces as the escalation envelope.
    const res = await postToRoute({ productId: "p1", paymentMethod: "lightning" });
    expect(res.statusCode).toBe(200);
    const body = res.body as Record<string, any>;
    expect(body.status).toBe("requires_escalation");
    expect(body.error).toEqual(expect.any(String));
    expect(body.code).toBe("exchange_rate_unavailable");
    // No order, but the escalation IS persisted (error + code, no order id)
    // so the self link resolves and the attempt shows up in the key's list.
    expect(mockCreateMcpOrder).not.toHaveBeenCalled();
    expect(mockInsertCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: body.id,
        status: "requires_escalation",
        mcpOrderId: null,
        error: expect.any(String),
        code: "exchange_rate_unavailable",
      })
    );
    // No fake 0 total on a pre-order escalation.
    expect(body).not.toHaveProperty("amount");
    const ok: boolean = validate(body);
    expect(
      ok
        ? true
        : `session schema rejected the escalation envelope: ${JSON.stringify(validate.errors)}`
    ).toBe(true);
  });

  it("200 requires_escalation persist failure falls back to a schema-valid ephemeral envelope", async () => {
    const validate = await compileSessionSchema();
    mockInsertCheckoutSession.mockRejectedValueOnce(new Error("db down"));
    const res = await postToRoute({ productId: "p1", paymentMethod: "lightning" });
    expect(res.statusCode).toBe(200);
    const body = res.body as Record<string, any>;
    expect(body.status).toBe("requires_escalation");
    expect(body.code).toBe("exchange_rate_unavailable");
    expect(body.warning).toEqual(
      expect.stringMatching(/could not be persisted/)
    );
    expect(body.id).toEqual(expect.stringMatching(/^ucp_cs_/));
    const ok: boolean = validate(body);
    expect(
      ok
        ? true
        : `session schema rejected the escalation fallback: ${JSON.stringify(validate.errors)}`
    ).toBe(true);
  });

  it("201 persist-failure fallback validates and keeps the payment descriptor", async () => {
    const validate = await compileSessionSchema();
    mockInsertCheckoutSession.mockRejectedValueOnce(new Error("db down"));
    const res = await postToRoute({ productId: "p1" });
    expect(res.statusCode).toBe(201);
    const body = res.body as Record<string, any>;
    expect(body.warning).toEqual(
      expect.stringMatching(/could not be persisted/)
    );
    expect(body.id).toEqual(expect.stringMatching(/^ucp_cs_/));
    const ok: boolean = validate(body);
    expect(
      ok
        ? true
        : `session schema rejected the persist-failure fallback: ${JSON.stringify(validate.errors)}`
    ).toBe(true);
  });
});
