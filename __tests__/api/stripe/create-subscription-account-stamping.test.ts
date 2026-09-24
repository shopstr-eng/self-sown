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
process.env.NEXT_PUBLIC_SELF_SOWN_PK = PLATFORM_PK;

const mockCustomersList = jest.fn();
const mockCustomersCreate = jest.fn();
const mockProductsCreate = jest.fn();
const mockPricesCreate = jest.fn();
const mockSubscriptionsCreate = jest.fn();
const mockInvoiceItemsCreate = jest.fn();
const mockCouponsCreate = jest.fn();
const mockInvoicePaymentsList = jest.fn();
const mockPaymentIntentsRetrieve = jest.fn();

// Apple Pay now checks seller-owned domains. Domain registration is outside
// these subscription persistence tests; do not open a real DB at import time.
jest.mock("@/utils/db/custom-domains", () => ({
  getDomainByHost: jest.fn().mockResolvedValue(null),
}));

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
    invoicePayments: {
      list: (...args: any[]) => mockInvoicePaymentsList(...args),
    },
    paymentIntents: {
      retrieve: (...args: any[]) => mockPaymentIntentsRetrieve(...args),
    },
  }));
  return { __esModule: true, default: Stripe };
});

const mockGetStripeConnectAccount = jest.fn();
const mockCreateSubscription = jest.fn();

jest.mock("@/utils/db/db-service", () => ({
  getStripeConnectAccount: (...args: any[]) =>
    mockGetStripeConnectAccount(...args),
  createSubscription: (...args: any[]) => mockCreateSubscription(...args),
  // utils/stripe/apple-pay.ts → utils/db/custom-domains.ts calls getDbPool()
  // at module scope; without this the suite dies at import time. The pool is
  // never queried here (requests carry no Host header, so the Apple Pay
  // trusted-host check returns null before any domain lookup).
  getDbPool: jest.fn(() => ({ query: jest.fn() })),
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
    (pk: string) => pk === process.env.NEXT_PUBLIC_SELF_SOWN_PK
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

jest.mock("@/utils/stripe/pending-payments", () => ({
  recordPendingPayment: jest.fn(async () => ({
    created: true,
    claimToken: "tok_stamp",
  })),
  reclaimPendingPayment: jest.fn(async () => null),
  updatePendingPayment: jest.fn(async () => undefined),
  getPendingPayment: jest.fn(async () => null),
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
    status: "incomplete",
    current_period_end: 1893456000,
    // Clover (Basil family) shape: NO top-level payment_intent on the
    // invoice — the route must resolve the PI via invoicePayments +
    // paymentIntents.retrieve or the buyer's card form never renders.
    latest_invoice: { id: "in_1" },
  });
  mockInvoicePaymentsList.mockResolvedValue({
    data: [{ payment: { payment_intent: "pi_1" } }],
  });
  mockPaymentIntentsRetrieve.mockResolvedValue({
    id: "pi_1",
    client_secret: "pi_secret",
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

  it("resolves the buyer's clientSecret via invoicePayments on the clover invoice shape", async () => {
    // #453: apiVersion 2025-09-30.clover (Basil family) removed
    // Invoice.payment_intent, so expand:["latest_invoice.payment_intent"]
    // silently yields nothing — the buyer's card form is gated on this
    // secret, and a null here means the form never renders. The default
    // fixture above is the clover shape.
    mockGetStripeConnectAccount.mockResolvedValue({
      stripe_account_id: CONNECT_ACCOUNT,
      charges_enabled: true,
    });

    const res = makeRes();
    await createSubscriptionHandler(makeReq(singleBody), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.clientSecret).toBe("pi_secret");
    // Direct charge on the connected account — the PI lookup must carry
    // the same stripeAccount header as the subscription create.
    expect(mockInvoicePaymentsList).toHaveBeenCalledWith(
      { invoice: "in_1", limit: 10 },
      { stripeAccount: CONNECT_ACCOUNT }
    );
    expect(mockPaymentIntentsRetrieve).toHaveBeenCalledWith(
      "pi_1",
      {},
      { stripeAccount: CONNECT_ACCOUNT }
    );
  });

  it("still resolves the pre-Basil expanded shape without the invoicePayments fallback", async () => {
    // If the API version pin ever rolls back, the expanded
    // latest_invoice.payment_intent must be used directly — the extra calls
    // must NOT fire (and nothing may 500 on their absence).
    mockSubscriptionsCreate.mockResolvedValue({
      id: "sub_1",
      status: "incomplete",
      current_period_end: 1893456000,
      latest_invoice: {
        id: "in_1",
        payment_intent: { id: "pi_1", client_secret: "pi_secret" },
      },
    });

    const res = makeRes();
    await createSubscriptionHandler(makeReq(singleBody), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.clientSecret).toBe("pi_secret");
    expect(mockInvoicePaymentsList).not.toHaveBeenCalled();
    expect(mockPaymentIntentsRetrieve).not.toHaveBeenCalled();
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

  it("a 100% donation on a single-seller cart is honored — the application fee is not collapsed to zero", async () => {
    mockGetStripeConnectAccount.mockResolvedValue({
      stripe_account_id: CONNECT_ACCOUNT,
      charges_enabled: true,
    });
    const donation = jest.requireMock("@/utils/stripe/donation");
    (donation.getSellerDonationPercent as jest.Mock).mockResolvedValue(100);

    const res = makeRes();
    await createCartSubscriptionHandler(
      makeReq({
        customerEmail: "buyer@example.com",
        items: [cartItem(SELLER_PK, "evt_item_1")],
      }),
      res
    );

    expect(res.statusCode).toBe(200);
    // 100% is UI-supported: the platform donation must take the whole
    // recurring amount — collapsing it to 0% would pay the seller in full.
    expect(mockSubscriptionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ application_fee_percent: 100 }),
      expect.anything()
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
        // Multi-seller recurring carts require a signed-in buyer (the whole-
        // subscription lifecycle is buyer-only; a guest could never manage it).
        buyerPubkey: "e".repeat(64),
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
