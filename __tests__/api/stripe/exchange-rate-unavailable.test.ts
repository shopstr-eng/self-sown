/** @jest-environment node */

// Route-level contract for the buyer-facing "exchange rate unavailable"
// failure (task #91): when the sats→fiat rate lookup fails, all three Stripe
// checkout routes must answer 503 with code "EXCHANGE_RATE_UNAVAILABLE" so the
// checkout cards show the friendly retry message — while non-rate failures
// keep the normal 500 shape WITHOUT the code. The currency module runs for
// real (only the upstream @getalby/lightning-tools feed is mocked) so the full
// wrap → isExchangeRateError → response-code chain is pinned end to end.

const PLATFORM_PK = "f".repeat(64);
process.env.NEXT_PUBLIC_MILK_MARKET_PK = PLATFORM_PK;
process.env.STRIPE_SECRET_KEY = "sk_test_platform";

const getFiatValueMock = jest.fn();
const getSatoshiValueMock = jest.fn();

jest.mock("@getalby/lightning-tools", () => ({
  __esModule: true,
  getFiatValue: (...args: unknown[]) => getFiatValueMock(...args),
  getSatoshiValue: (...args: unknown[]) => getSatoshiValueMock(...args),
}));

const stripePaymentIntentsCreateMock = jest.fn();
const mockCustomersList = jest.fn();
const mockCustomersCreate = jest.fn();
const mockProductsCreate = jest.fn();
const mockPricesCreate = jest.fn();
const mockSubscriptionsCreate = jest.fn();
const mockInvoiceItemsCreate = jest.fn();
const mockCouponsCreate = jest.fn();

jest.mock("stripe", () => {
  const Stripe = jest.fn().mockImplementation(() => ({
    paymentIntents: {
      create: (...args: unknown[]) => stripePaymentIntentsCreateMock(...args),
    },
    customers: {
      list: (...args: any[]) => mockCustomersList(...args),
      create: (...args: any[]) => mockCustomersCreate(...args),
    },
    products: { create: (...args: any[]) => mockProductsCreate(...args) },
    prices: { create: (...args: any[]) => mockPricesCreate(...args) },
    subscriptions: {
      create: (...args: any[]) => mockSubscriptionsCreate(...args),
    },
    invoiceItems: {
      create: (...args: any[]) => mockInvoiceItemsCreate(...args),
    },
    coupons: { create: (...args: any[]) => mockCouponsCreate(...args) },
  }));
  return { __esModule: true, default: Stripe };
});

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn(async () => true),
}));

const mockGetStripeConnectAccount = jest.fn();
const mockCreateSubscription = jest.fn();
jest.mock("@/utils/db/db-service", () => ({
  getStripeConnectAccount: (...args: any[]) =>
    mockGetStripeConnectAccount(...args),
  createSubscription: (...args: any[]) => mockCreateSubscription(...args),
}));

jest.mock("@/utils/self-host/config", () => ({
  getSelfHostConfig: jest.fn(() => ({
    enabled: false,
    tenantPubkey: null,
    tenantSlug: null,
    relays: [],
    blossomServers: [],
    ownStripe: false,
    upstreamRepo: "https://github.com/shopstr-eng/milk-market",
  })),
  isSelfHostTenant: jest.fn(() => false),
}));

jest.mock("@/utils/stripe/pending-payments", () => ({
  recordPendingPayment: jest.fn(async () => undefined),
  updatePendingPayment: jest.fn(async () => undefined),
}));

jest.mock("@/utils/stripe/donation", () => ({
  resolveDonationCut: jest.fn(async () => ({ percent: 0, cutSmallest: 0 })),
  getSellerDonationPercent: jest.fn(async () => null),
  isPlatformPubkey: jest.fn(
    (pk: string) => pk === process.env.NEXT_PUBLIC_MILK_MARKET_PK
  ),
  computeDonationCutSmallest: jest.fn(() => 0),
}));

jest.mock("@/utils/stripe/retry-service", () => ({
  withStripeRetry: (fn: any) => fn(),
  stableIdempotencyKey: jest.fn(() => "idem_key"),
}));

jest.mock("@/utils/db/affiliates", () => ({
  computeBuyerDiscountSmallest: jest.fn(() => 0),
  isAffiliateCodeValid: jest.fn(async () => false),
  isSelfReferral: jest.fn(() => false),
  lookupAffiliateCode: jest.fn(async () => null),
}));

import createPaymentIntentHandler from "@/pages/api/stripe/create-payment-intent";
import createSubscriptionHandler from "@/pages/api/stripe/create-subscription";
import createCartSubscriptionHandler from "@/pages/api/stripe/create-cart-subscription";
import {
  exchangeRateRetryConfig,
  _resetExchangeRateCache,
  EXCHANGE_RATE_ERROR_CODE,
} from "@/utils/stripe/currency";

const SELLER_PK = "b".repeat(64);

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

const defaultRetryConfig = { ...exchangeRateRetryConfig };

beforeEach(() => {
  jest.clearAllMocks();
  getFiatValueMock.mockReset();
  // Keep the fail-closed retries instant and make sure a last-good rate cached
  // by an earlier success can't mask a feed outage in a later test.
  _resetExchangeRateCache();
  Object.assign(exchangeRateRetryConfig, defaultRetryConfig);
  exchangeRateRetryConfig.retryBaseMs = 0;

  mockGetStripeConnectAccount.mockResolvedValue({
    stripe_account_id: "acct_seller",
    charges_enabled: true,
  });
  mockCreateSubscription.mockResolvedValue(undefined);
  mockCustomersList.mockResolvedValue({ data: [] });
  mockCustomersCreate.mockResolvedValue({ id: "cus_1" });
  mockProductsCreate.mockResolvedValue({ id: "prod_1" });
  mockPricesCreate.mockResolvedValue({ id: "price_1" });
  mockSubscriptionsCreate.mockResolvedValue({
    id: "sub_1",
    status: "active",
    current_period_end: 1893456000,
    latest_invoice: { payment_intent: { client_secret: "pi_secret" } },
  });
  mockInvoiceItemsCreate.mockResolvedValue({ id: "ii_1" });
  mockCouponsCreate.mockResolvedValue({ id: "coupon_1" });
  stripePaymentIntentsCreateMock.mockResolvedValue({
    id: "pi_123",
    client_secret: "pi_123_secret",
  });
});

afterAll(() => {
  Object.assign(exchangeRateRetryConfig, defaultRetryConfig);
});

// Every route: rate failure → 503 + stable code; non-rate failure → 500,
// NO code (the buyer UI keys the friendly retry message off the code).
describe("exchange-rate-unavailable contract across Stripe checkout routes", () => {
  describe("POST /api/stripe/create-payment-intent", () => {
    it("returns 503 + code when the sats→USD rate lookup fails", async () => {
      getFiatValueMock.mockRejectedValue(new Error("rate feed down"));
      const res = makeRes();
      await createPaymentIntentHandler(
        makeReq({
          amount: 50000,
          currency: "sats",
          metadata: { sellerPubkey: SELLER_PK },
        }),
        res
      );
      expect(res.statusCode).toBe(503);
      expect((res.body as any).code).toBe(EXCHANGE_RATE_ERROR_CODE);
      expect(String((res.body as any).error)).toMatch(
        /failed to create payment intent/i
      );
      expect(stripePaymentIntentsCreateMock).not.toHaveBeenCalled();
    });

    it("returns the normal 500 shape (no code) for a non-rate failure", async () => {
      stripePaymentIntentsCreateMock.mockRejectedValue(
        new Error("card declined")
      );
      const res = makeRes();
      await createPaymentIntentHandler(
        makeReq({
          amount: 10,
          currency: "usd",
          metadata: { sellerPubkey: SELLER_PK },
        }),
        res
      );
      expect(res.statusCode).toBe(500);
      expect((res.body as any)).not.toHaveProperty("code");
      expect(String((res.body as any).error)).toMatch(
        /failed to create payment intent/i
      );
    });
  });

  describe("POST /api/stripe/create-subscription", () => {
    const subBody = {
      customerEmail: "buyer@example.com",
      productTitle: "Coffee Subscription",
      frequency: "monthly",
      sellerPubkey: SELLER_PK,
      productEventId: "evt_product_1",
    };

    it("returns 503 + code when the sats→USD rate lookup fails", async () => {
      getFiatValueMock.mockRejectedValue(new Error("rate feed down"));
      const res = makeRes();
      await createSubscriptionHandler(
        makeReq({ ...subBody, amount: 50000, currency: "sats" }),
        res
      );
      expect(res.statusCode).toBe(503);
      expect((res.body as any).code).toBe(EXCHANGE_RATE_ERROR_CODE);
      expect(String((res.body as any).error)).toMatch(
        /failed to create subscription/i
      );
      expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
    });

    it("returns the normal 500 shape (no code) for a non-rate failure", async () => {
      mockSubscriptionsCreate.mockRejectedValue(new Error("stripe down"));
      const res = makeRes();
      await createSubscriptionHandler(
        makeReq({ ...subBody, amount: 10, currency: "USD" }),
        res
      );
      expect(res.statusCode).toBe(500);
      expect((res.body as any)).not.toHaveProperty("code");
      expect(String((res.body as any).error)).toMatch(
        /failed to create subscription/i
      );
    });
  });

  describe("POST /api/stripe/create-cart-subscription", () => {
    const cartReq = (currency: string, amount: number) => ({
      customerEmail: "buyer@example.com",
      items: [
        {
          sellerPubkey: SELLER_PK,
          productEventId: "evt_item_1",
          productTitle: "Coffee",
          amount,
          currency,
          frequency: "monthly",
          isSubscription: true,
        },
      ],
    });

    it("returns 503 + code when the sats→USD rate lookup fails", async () => {
      getFiatValueMock.mockRejectedValue(new Error("rate feed down"));
      const res = makeRes();
      await createCartSubscriptionHandler(
        makeReq(cartReq("sats", 50000)),
        res
      );
      expect(res.statusCode).toBe(503);
      expect((res.body as any).code).toBe(EXCHANGE_RATE_ERROR_CODE);
      expect(String((res.body as any).error)).toMatch(
        /failed to create cart subscription/i
      );
      expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
    });

    it("returns the normal 500 shape (no code) for a non-rate failure", async () => {
      mockSubscriptionsCreate.mockRejectedValue(new Error("stripe down"));
      const res = makeRes();
      await createCartSubscriptionHandler(
        makeReq(cartReq("USD", 10)),
        res
      );
      expect(res.statusCode).toBe(500);
      expect((res.body as any)).not.toHaveProperty("code");
      expect(String((res.body as any).error)).toMatch(
        /failed to create cart subscription/i
      );
    });
  });
});
