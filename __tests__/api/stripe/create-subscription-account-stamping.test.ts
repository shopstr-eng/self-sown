/** @jest-environment node */

// Route-level coverage for connected_account_id stamping at subscription
// creation time. If that write silently regresses (a refactor drops the
// field), every new subscription becomes a legacy row whose cancel/update
// resolve the seller's CURRENT Connect account — the orphan-cancellation bug
// returns and nothing fails. These tests pin: single-seller creation stamps
// the seller's Connect account id when one exists, null for the platform
// account, and the multi-merchant cart path always stamps null (the
// subscription lives on the platform account and splits via transfers).

const PLATFORM_PK = "c".repeat(64);
process.env.NEXT_PUBLIC_MILK_MARKET_PK = PLATFORM_PK;

const mockCustomersList = jest.fn();
const mockCustomersCreate = jest.fn();
const mockProductsCreate = jest.fn();
const mockPricesCreate = jest.fn();
const mockSubscriptionsCreate = jest.fn();
const mockInvoiceItemsCreate = jest.fn();
const mockCouponsCreate = jest.fn();

jest.mock("stripe", () => {
  const Stripe = jest.fn().mockImplementation(() => ({
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

const mockGetStripeConnectAccount = jest.fn();
const mockCreateSubscription = jest.fn();

jest.mock("@/utils/db/db-service", () => ({
  getStripeConnectAccount: (...args: any[]) =>
    mockGetStripeConnectAccount(...args),
  createSubscription: (...args: any[]) => mockCreateSubscription(...args),
}));

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn(async () => true),
}));

jest.mock("@/utils/stripe/retry-service", () => ({
  withStripeRetry: (fn: any) => fn(),
  stableIdempotencyKey: jest.fn(() => "idem_key"),
}));

jest.mock("@/utils/stripe/donation", () => ({
  getSellerDonationPercent: jest.fn(async () => null),
  isPlatformPubkey: jest.fn(
    (pk: string) => pk === process.env.NEXT_PUBLIC_MILK_MARKET_PK
  ),
  computeDonationCutSmallest: jest.fn(() => 0),
}));

jest.mock("@/utils/stripe/currency", () => ({
  ZERO_DECIMAL_CURRENCIES: new Set(["jpy"]),
  isCrypto: jest.fn(() => false),
  convertToSmallestUnit: jest.fn(async (amount: number, currency: string) => ({
    amountSmallest: Math.round(amount * 100),
    stripeCurrency: currency.toLowerCase(),
  })),
  isExchangeRateError: jest.fn(() => false),
  EXCHANGE_RATE_ERROR_CODE: "EXCHANGE_RATE_UNAVAILABLE",
}));

jest.mock("@/utils/db/affiliates", () => ({
  computeBuyerDiscountSmallest: jest.fn(() => 0),
  isAffiliateCodeValid: jest.fn(async () => false),
  isSelfReferral: jest.fn(() => false),
  lookupAffiliateCode: jest.fn(async () => null),
}));

import createSubscriptionHandler from "@/pages/api/stripe/create-subscription";
import createCartSubscriptionHandler from "@/pages/api/stripe/create-cart-subscription";

const SELLER_PK = "b".repeat(64);
const SELLER2_PK = "d".repeat(64);
const CONNECT_ACCOUNT = "acct_seller_connected";

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

beforeEach(() => {
  jest.clearAllMocks();
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
  mockCreateSubscription.mockResolvedValue(undefined);
});

const singleBody = {
  customerEmail: "buyer@example.com",
  productTitle: "Coffee Subscription",
  amount: 10,
  currency: "USD",
  frequency: "monthly",
  sellerPubkey: SELLER_PK,
  productEventId: "evt_product_1",
};

describe("POST /api/stripe/create-subscription — connected_account_id stamping", () => {
  it("stamps the seller's Connect account id when the seller has one enabled", async () => {
    mockGetStripeConnectAccount.mockResolvedValue({
      stripe_account_id: CONNECT_ACCOUNT,
      charges_enabled: true,
    });

    const res = makeRes();
    await createSubscriptionHandler(makeReq(singleBody), res);

    expect(res.statusCode).toBe(200);
    expect(mockCreateSubscription).toHaveBeenCalledTimes(1);
    expect(mockCreateSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ connected_account_id: CONNECT_ACCOUNT })
    );
  });

  it("stamps null for the platform account and skips the Connect lookup", async () => {
    const res = makeRes();
    await createSubscriptionHandler(
      makeReq({ ...singleBody, sellerPubkey: PLATFORM_PK }),
      res
    );

    expect(res.statusCode).toBe(200);
    expect(mockGetStripeConnectAccount).not.toHaveBeenCalled();
    expect(mockCreateSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ connected_account_id: null })
    );
  });

  it("stamps null when the seller has no Connect account", async () => {
    mockGetStripeConnectAccount.mockResolvedValue(null);

    const res = makeRes();
    await createSubscriptionHandler(makeReq(singleBody), res);

    expect(res.statusCode).toBe(200);
    expect(mockCreateSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ connected_account_id: null })
    );
  });
});

describe("POST /api/stripe/create-cart-subscription — connected_account_id stamping", () => {
  const cartItem = (sellerPubkey: string, eventId: string) => ({
    sellerPubkey,
    productEventId: eventId,
    productTitle: "Coffee",
    amount: 10,
    currency: "USD",
    frequency: "monthly",
    isSubscription: true,
  });

  it("single-seller cart stamps the seller's Connect account id", async () => {
    mockGetStripeConnectAccount.mockResolvedValue({
      stripe_account_id: CONNECT_ACCOUNT,
      charges_enabled: true,
    });

    const res = makeRes();
    await createCartSubscriptionHandler(
      makeReq({
        customerEmail: "buyer@example.com",
        items: [cartItem(SELLER_PK, "evt_item_1")],
      }),
      res
    );

    expect(res.statusCode).toBe(200);
    expect(mockCreateSubscription).toHaveBeenCalledTimes(1);
    expect(mockCreateSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ connected_account_id: CONNECT_ACCOUNT })
    );
  });

  it("multi-merchant cart stamps null — the subscription lives on the platform account", async () => {
    mockGetStripeConnectAccount.mockImplementation(async (pk: string) => ({
      stripe_account_id: `acct_${pk.slice(0, 4)}`,
      charges_enabled: true,
    }));

    const res = makeRes();
    await createCartSubscriptionHandler(
      makeReq({
        customerEmail: "buyer@example.com",
        items: [
          cartItem(SELLER_PK, "evt_item_1"),
          cartItem(SELLER2_PK, "evt_item_2"),
        ],
      }),
      res
    );

    expect(res.statusCode).toBe(200);
    expect(mockCreateSubscription).toHaveBeenCalledTimes(2);
    for (const call of mockCreateSubscription.mock.calls) {
      expect(call[0].connected_account_id).toBeNull();
    }
  });
});
