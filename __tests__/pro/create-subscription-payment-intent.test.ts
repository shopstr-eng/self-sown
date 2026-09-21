/** @jest-environment node */

// Route-level coverage for pages/api/pro/create-subscription.ts PaymentIntent
// resolution. #453: apiVersion 2025-09-30.clover (Basil family) removed
// Invoice.payment_intent, so expand:["latest_invoice.payment_intent"]
// silently yields nothing and the route returned clientSecret: null — the
// seller's Pro card form never renders. The route must resolve the PI via
// the shared dual-shape helper (invoicePayments.list + paymentIntents.
// retrieve). These fixtures use the clover invoice shape so the drift
// can't regress silently.

const mockApplyRateLimit = jest.fn();
const mockVerifyProof = jest.fn();
const mockEnsureProPrice = jest.fn();
const mockGetOrCreateProCustomer = jest.fn();
const mockSyncProStripeMeta = jest.fn();
const mockGetSellerNotificationEmail = jest.fn();
const mockSubscriptionsCreate = jest.fn();
const mockInvoicePaymentsList = jest.fn();
const mockPaymentIntentsRetrieve = jest.fn();

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: (...args: unknown[]) => mockApplyRateLimit(...args),
}));

jest.mock("@/utils/nostr/request-auth", () => ({
  buildProCreateSubscriptionProof: jest.fn(() => ({})),
  extractSignedEventFromRequest: jest.fn(() => ({})),
  verifySignedHttpRequestProof: (...args: unknown[]) =>
    mockVerifyProof(...args),
}));

jest.mock("@/utils/pro/stripe-pro", () => ({
  ensureProPrice: (...args: unknown[]) => mockEnsureProPrice(...args),
  getOrCreateProCustomer: (...args: unknown[]) =>
    mockGetOrCreateProCustomer(...args),
  getProStripe: () => ({
    subscriptions: {
      create: (...args: unknown[]) => mockSubscriptionsCreate(...args),
    },
    invoicePayments: {
      list: (...args: unknown[]) => mockInvoicePaymentsList(...args),
    },
    paymentIntents: {
      retrieve: (...args: unknown[]) => mockPaymentIntentsRetrieve(...args),
    },
  }),
}));

jest.mock("@/utils/stripe/retry-service", () => ({
  withStripeRetry: (fn: () => unknown) => fn(),
  stableIdempotencyKey: jest.fn(() => "idem_key"),
}));

jest.mock("@/utils/db/pro-membership", () => ({
  syncProStripeMeta: (...args: unknown[]) => mockSyncProStripeMeta(...args),
}));

jest.mock("@/utils/db/db-service", () => ({
  // db-service-mock-getdbpool: utils/db/* call getDbPool() at module scope.
  getDbPool: jest.fn(),
  getSellerNotificationEmail: (...args: unknown[]) =>
    mockGetSellerNotificationEmail(...args),
}));

import handler from "@/pages/api/pro/create-subscription";

const SELLER_PK = "a".repeat(64);

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
  mockApplyRateLimit.mockResolvedValue(true);
  mockVerifyProof.mockReturnValue({ ok: true });
  mockEnsureProPrice.mockResolvedValue("price_pro_monthly");
  mockGetOrCreateProCustomer.mockResolvedValue("cus_pro_1");
  mockGetSellerNotificationEmail.mockResolvedValue("seller@example.com");
  mockSyncProStripeMeta.mockResolvedValue(undefined);
  // Clover (Basil family) shape: NO top-level payment_intent on the
  // invoice — the PI must be resolved via invoicePayments.
  mockSubscriptionsCreate.mockResolvedValue({
    id: "sub_pro_1",
    status: "incomplete",
    cancel_at_period_end: false,
    latest_invoice: { id: "in_pro_1" },
  });
  mockInvoicePaymentsList.mockResolvedValue({
    data: [{ payment: { payment_intent: "pi_pro_1" } }],
  });
  mockPaymentIntentsRetrieve.mockResolvedValue({
    id: "pi_pro_1",
    client_secret: "pi_pro_secret",
  });
});

const validBody = { pubkey: SELLER_PK, term: "monthly" };

describe("POST /api/pro/create-subscription — PaymentIntent resolution", () => {
  it("returns the card-form clientSecret via invoicePayments on the clover invoice shape", async () => {
    const res = makeRes();
    await handler(makeReq(validBody), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.subscriptionId).toBe("sub_pro_1");
    expect(res.body.clientSecret).toBe("pi_pro_secret");
    expect(mockInvoicePaymentsList).toHaveBeenCalledWith(
      { invoice: "in_pro_1", limit: 10 },
      undefined
    );
    expect(mockPaymentIntentsRetrieve).toHaveBeenCalledWith(
      "pi_pro_1",
      {},
      undefined
    );
  });

  it("still resolves the pre-Basil expanded shape without the invoicePayments fallback", async () => {
    mockSubscriptionsCreate.mockResolvedValue({
      id: "sub_pro_1",
      status: "incomplete",
      cancel_at_period_end: false,
      latest_invoice: {
        id: "in_pro_1",
        payment_intent: { id: "pi_pro_1", client_secret: "pi_pro_secret" },
      },
    });

    const res = makeRes();
    await handler(makeReq(validBody), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.clientSecret).toBe("pi_pro_secret");
    expect(mockInvoicePaymentsList).not.toHaveBeenCalled();
    expect(mockPaymentIntentsRetrieve).not.toHaveBeenCalled();
  });
});
