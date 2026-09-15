/** @jest-environment node */

// Verifies the Stripe Price lookup-key find-or-create after the milkmarket_*
// → selfsown_* rename completed (legacy dual-read retired: the platform
// account was verified to hold no legacy-keyed Prices). ensureProPrice /
// ensureWranglerLifetimePrice must reuse an existing Price keyed by the
// selfsown_* lookup key (never mint a duplicate) and create one only when
// none exists. Route-level tests then prove the checkout endpoints still
// charge the correct amounts.

const mockPricesList = jest.fn();
const mockPricesCreate = jest.fn();
const mockProductsSearch = jest.fn();
const mockProductsCreate = jest.fn();
const mockCustomersSearch = jest.fn();
const mockCustomersCreate = jest.fn();
const mockSubscriptionsCreate = jest.fn();
const mockPaymentIntentsCreate = jest.fn();

jest.mock("stripe", () => {
  const Stripe = jest.fn().mockImplementation(() => ({
    prices: {
      list: (...args: any[]) => mockPricesList(...args),
      create: (...args: any[]) => mockPricesCreate(...args),
    },
    products: {
      search: (...args: any[]) => mockProductsSearch(...args),
      create: (...args: any[]) => mockProductsCreate(...args),
    },
    customers: {
      search: (...args: any[]) => mockCustomersSearch(...args),
      create: (...args: any[]) => mockCustomersCreate(...args),
    },
    subscriptions: {
      create: (...args: any[]) => mockSubscriptionsCreate(...args),
    },
    paymentIntents: {
      create: (...args: any[]) => mockPaymentIntentsCreate(...args),
    },
  }));
  return { __esModule: true, default: Stripe };
});

jest.mock("@/utils/stripe/retry-service", () => {
  const actual = jest.requireActual("@/utils/stripe/retry-service");
  return {
    ...actual,
    withStripeRetry: (fn: () => unknown) => fn(),
  };
});

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn(async () => true),
}));

jest.mock("@/utils/nostr/request-auth", () => ({
  buildProCreateSubscriptionProof: jest.fn(() => ({})),
  buildProCreateLifetimeProof: jest.fn(() => ({})),
  extractSignedEventFromRequest: jest.fn(() => ({ pubkey: "a".repeat(64) })),
  verifySignedHttpRequestProof: jest.fn(() => ({ ok: true })),
}));

jest.mock("@/utils/db/pro-membership", () => ({
  syncProStripeMeta: jest.fn(async () => {}),
}));

jest.mock("@/utils/db/db-service", () => ({
  getSellerNotificationEmail: jest.fn(async () => null),
}));

import {
  PRO_ANNUAL_LOOKUP_KEY,
  PRO_ANNUAL_PRICE_CENTS,
  PRO_MONTHLY_LOOKUP_KEY,
  PRO_MONTHLY_PRICE_CENTS,
  PRO_PRICE_CURRENCY,
  WRANGLER_LIFETIME_LOOKUP_KEY,
  WRANGLER_LIFETIME_PRICE_CENTS,
} from "@/utils/pro/constants";
import {
  ensureProPrice,
  ensureWranglerLifetimePrice,
} from "@/utils/pro/stripe-pro";
import createSubscriptionHandler from "@/pages/api/pro/create-subscription";
import createLifetimeHandler from "@/pages/api/pro/create-lifetime";

const SELLER_PUBKEY = "a".repeat(64);

beforeEach(() => {
  jest.clearAllMocks();
  mockCustomersSearch.mockResolvedValue({ data: [{ id: "cus_1" }] });
  mockCustomersCreate.mockResolvedValue({ id: "cus_1" });
  mockProductsSearch.mockResolvedValue({ data: [{ id: "prod_herd" }] });
  mockProductsCreate.mockResolvedValue({ id: "prod_herd" });
  mockSubscriptionsCreate.mockResolvedValue({
    id: "sub_1",
    status: "incomplete",
    cancel_at_period_end: false,
    latest_invoice: { payment_intent: { client_secret: "pi_sub_secret" } },
  });
  mockPaymentIntentsCreate.mockResolvedValue({
    id: "pi_1",
    client_secret: "pi_lifetime_secret",
  });
});

describe("lookup-key constants", () => {
  it("keys are the selfsown_* set (milkmarket_* fallback retired)", () => {
    expect(PRO_MONTHLY_LOOKUP_KEY).toBe("selfsown_pro_monthly_v1");
    expect(PRO_ANNUAL_LOOKUP_KEY).toBe("selfsown_pro_annual_v1");
    expect(WRANGLER_LIFETIME_LOOKUP_KEY).toBe("selfsown_wrangler_lifetime_v1");
  });
});

describe("ensureProPrice find-or-create", () => {
  it("queries the selfsown_* key in one list call", async () => {
    mockPricesList.mockResolvedValue({
      data: [{ id: "price_new_monthly", lookup_key: PRO_MONTHLY_LOOKUP_KEY }],
    });

    const priceId = await ensureProPrice("monthly");

    expect(priceId).toBe("price_new_monthly");
    expect(mockPricesList).toHaveBeenCalledWith({
      lookup_keys: [PRO_MONTHLY_LOOKUP_KEY],
      active: true,
      limit: 1,
    });
    expect(mockPricesCreate).not.toHaveBeenCalled();
  });

  it("reuses the existing monthly Price (no duplicate minted)", async () => {
    mockPricesList.mockResolvedValue({
      data: [{ id: "price_new_monthly", lookup_key: PRO_MONTHLY_LOOKUP_KEY }],
    });

    const priceId = await ensureProPrice("monthly");

    expect(priceId).toBe("price_new_monthly");
    expect(mockPricesCreate).not.toHaveBeenCalled();
    expect(mockProductsCreate).not.toHaveBeenCalled();
  });

  it("creates the monthly Price with the selfsown_* key and $21/mo only when none exists", async () => {
    mockPricesList.mockResolvedValue({ data: [] });
    mockPricesCreate.mockResolvedValue({ id: "price_created_monthly" });

    const priceId = await ensureProPrice("monthly");

    expect(priceId).toBe("price_created_monthly");
    expect(mockPricesCreate).toHaveBeenCalledWith(
      {
        product: "prod_herd",
        unit_amount: PRO_MONTHLY_PRICE_CENTS,
        currency: PRO_PRICE_CURRENCY,
        recurring: { interval: "month" },
        lookup_key: PRO_MONTHLY_LOOKUP_KEY,
        metadata: { ss_pro: "true", mm_pro: "true", term: "monthly" },
      },
      { idempotencyKey: expect.stringContaining("pro-price-") }
    );
    expect(PRO_MONTHLY_PRICE_CENTS).toBe(2100);
    // Reused the existing "Self-sown Herd" product instead of making a new one.
    expect(mockProductsCreate).not.toHaveBeenCalled();
  });

  it("creates the yearly Price with the selfsown_* key and $168/yr when none exists", async () => {
    mockPricesList.mockResolvedValue({ data: [] });
    mockPricesCreate.mockResolvedValue({ id: "price_created_yearly" });

    const priceId = await ensureProPrice("yearly");

    expect(priceId).toBe("price_created_yearly");
    expect(mockPricesList).toHaveBeenCalledWith({
      lookup_keys: [PRO_ANNUAL_LOOKUP_KEY],
      active: true,
      limit: 1,
    });
    expect(mockPricesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        unit_amount: PRO_ANNUAL_PRICE_CENTS,
        recurring: { interval: "year" },
        lookup_key: PRO_ANNUAL_LOOKUP_KEY,
      }),
      expect.anything()
    );
    expect(PRO_ANNUAL_PRICE_CENTS).toBe(16800);
  });
});

describe("ensureWranglerLifetimePrice find-or-create", () => {
  it("reuses the existing lifetime Price (no duplicate minted)", async () => {
    mockPricesList.mockResolvedValue({
      data: [
        { id: "price_new_lifetime", lookup_key: WRANGLER_LIFETIME_LOOKUP_KEY },
      ],
    });

    const priceId = await ensureWranglerLifetimePrice();

    expect(priceId).toBe("price_new_lifetime");
    expect(mockPricesList).toHaveBeenCalledWith({
      lookup_keys: [WRANGLER_LIFETIME_LOOKUP_KEY],
      active: true,
      limit: 1,
    });
    expect(mockPricesCreate).not.toHaveBeenCalled();
  });

  it("creates a one-time $2,100 Price with the selfsown_* key when none exists", async () => {
    mockPricesList.mockResolvedValue({ data: [] });
    mockPricesCreate.mockResolvedValue({ id: "price_created_lifetime" });

    const priceId = await ensureWranglerLifetimePrice();

    expect(priceId).toBe("price_created_lifetime");
    const [createArgs] = mockPricesCreate.mock.calls[0];
    expect(createArgs).toMatchObject({
      product: "prod_herd",
      unit_amount: WRANGLER_LIFETIME_PRICE_CENTS,
      currency: PRO_PRICE_CURRENCY,
      lookup_key: WRANGLER_LIFETIME_LOOKUP_KEY,
    });
    // One-time price: no recurring config.
    expect(createArgs.recurring).toBeUndefined();
    expect(WRANGLER_LIFETIME_PRICE_CENTS).toBe(210000);
  });
});

function makeRes() {
  const res: any = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

function makeReq(body: Record<string, unknown>) {
  return { method: "POST", body, headers: {} } as any;
}

// NOTE on charge amounts: the recurring checkout charges whatever the resolved
// Stripe Price carries — the route only threads the Price ID. These fixtures
// therefore carry full Price attributes (unit_amount/currency/recurring) so the
// tests pin which priced object the subscription bills, and the create-path
// tests above pin the attributes a freshly minted Price would get. The Wrangler
// route is different: it charges WRANGLER_LIFETIME_PRICE_CENTS directly on the
// PaymentIntent, asserted below.
describe("POST /api/pro/create-subscription — checkout with renamed keys", () => {
  it("subscribes the seller to the reused renamed monthly Price ($21/mo)", async () => {
    mockPricesList.mockResolvedValue({
      data: [
        {
          id: "price_new_monthly",
          lookup_key: PRO_MONTHLY_LOOKUP_KEY,
          unit_amount: PRO_MONTHLY_PRICE_CENTS,
          currency: PRO_PRICE_CURRENCY,
          recurring: { interval: "month" },
        },
      ],
    });

    const res = makeRes();
    await createSubscriptionHandler(
      makeReq({ pubkey: SELLER_PUBKEY, term: "monthly" }),
      res
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      subscriptionId: "sub_1",
      clientSecret: "pi_sub_secret",
    });
    // The subscription bills the existing $21/mo Price — no new Price was minted.
    expect(mockSubscriptionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: "cus_1",
        items: [{ price: "price_new_monthly" }],
      }),
      expect.anything()
    );
    expect(mockPricesCreate).not.toHaveBeenCalled();
  });

  it("subscribes the seller to the reused renamed yearly Price ($168/yr)", async () => {
    mockPricesList.mockResolvedValue({
      data: [
        {
          id: "price_new_yearly",
          lookup_key: PRO_ANNUAL_LOOKUP_KEY,
          unit_amount: PRO_ANNUAL_PRICE_CENTS,
          currency: PRO_PRICE_CURRENCY,
          recurring: { interval: "year" },
        },
      ],
    });

    const res = makeRes();
    await createSubscriptionHandler(
      makeReq({ pubkey: SELLER_PUBKEY, term: "yearly" }),
      res
    );

    expect(res.statusCode).toBe(200);
    expect(mockPricesList).toHaveBeenCalledWith({
      lookup_keys: [PRO_ANNUAL_LOOKUP_KEY],
      active: true,
      limit: 1,
    });
    expect(mockSubscriptionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: "cus_1",
        items: [{ price: "price_new_yearly" }],
        metadata: expect.objectContaining({ term: "yearly" }),
      }),
      expect.anything()
    );
    expect(mockPricesCreate).not.toHaveBeenCalled();
  });
});

describe("POST /api/pro/create-lifetime — checkout with renamed keys", () => {
  it("charges the fixed $2,100 lifetime amount and reuses the renamed Price", async () => {
    mockPricesList.mockResolvedValue({
      data: [
        { id: "price_new_lifetime", lookup_key: WRANGLER_LIFETIME_LOOKUP_KEY },
      ],
    });

    const res = makeRes();
    await createLifetimeHandler(makeReq({ pubkey: SELLER_PUBKEY }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      paymentIntentId: "pi_1",
      clientSecret: "pi_lifetime_secret",
    });
    expect(mockPaymentIntentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: "cus_1",
        amount: WRANGLER_LIFETIME_PRICE_CENTS,
        currency: PRO_PRICE_CURRENCY,
      }),
      expect.anything()
    );
    expect(mockPricesCreate).not.toHaveBeenCalled();
  });
});
