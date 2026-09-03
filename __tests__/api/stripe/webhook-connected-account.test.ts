/** @jest-environment node */

// Route-level coverage for renewal webhooks resolving subscriptions that live
// on the seller's Stripe Connect account. Recurring subscriptions are created
// on the connected account (the subscriptions row stamps connected_account_id),
// so a platform-account stripe.subscriptions.retrieve without { stripeAccount }
// will not find them. Both renewal handlers must pass the recorded account.

const mockConstructEvent = jest.fn();
const mockSubscriptionsRetrieve = jest.fn();
const mockTransfersCreate = jest.fn();
const mockPaymentIntentsRetrieve = jest.fn();

jest.mock("stripe", () => {
  const Stripe = jest.fn().mockImplementation(() => ({
    webhooks: {
      constructEvent: (...args: any[]) => mockConstructEvent(...args),
    },
    subscriptions: {
      retrieve: (...args: any[]) => mockSubscriptionsRetrieve(...args),
    },
    transfers: {
      create: (...args: any[]) => mockTransfersCreate(...args),
    },
    paymentIntents: {
      retrieve: (...args: any[]) => mockPaymentIntentsRetrieve(...args),
    },
  }));
  return { __esModule: true, default: Stripe };
});

const mockGetSubscriptionByStripeId = jest.fn();
const mockUpdateSubscriptionStatus = jest.fn();
const mockUpdateSubscriptionBillingDate = jest.fn();
const mockCreateSubscriptionNotification = jest.fn();
const mockGetStripeConnectAccount = jest.fn();
const mockGetSellerNotificationEmail = jest.fn();

jest.mock("@/utils/db/db-service", () => ({
  getSubscriptionByStripeId: (...args: any[]) =>
    mockGetSubscriptionByStripeId(...args),
  updateSubscriptionStatus: (...args: any[]) =>
    mockUpdateSubscriptionStatus(...args),
  updateSubscriptionBillingDate: (...args: any[]) =>
    mockUpdateSubscriptionBillingDate(...args),
  createSubscriptionNotification: (...args: any[]) =>
    mockCreateSubscriptionNotification(...args),
  getStripeConnectAccount: (...args: any[]) =>
    mockGetStripeConnectAccount(...args),
  getSellerNotificationEmail: (...args: any[]) =>
    mockGetSellerNotificationEmail(...args),
}));

jest.mock("@/utils/email/email-service", () => ({
  sendRenewalReminder: jest.fn(async () => undefined),
  sendSubscriptionCancellation: jest.fn(async () => undefined),
  sendPaymentFailedToBuyer: jest.fn(async () => undefined),
  sendPaymentFailedToSeller: jest.fn(async () => undefined),
  sendTransferFailureAlert: jest.fn(async () => undefined),
}));

jest.mock("@/utils/nostr/server-nostr-helpers", () => ({
  sendServerSideNostrDM: jest.fn(async () => undefined),
}));

jest.mock("@/utils/email/storefront-branding", () => ({
  loadStorefrontBranding: jest.fn(async () => null),
}));

jest.mock("@/utils/db/affiliates", () => ({
  computeRebateSmallest: jest.fn(() => 0),
  isAffiliateCodeValid: jest.fn(async () => false),
  lookupAffiliateCode: jest.fn(async () => null),
  recordReferral: jest.fn(async () => undefined),
  reverseReferralsForOrder: jest.fn(async () => undefined),
}));

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn(async () => true),
}));

const mockClaimStripeEvent = jest.fn();
const mockFinalizeStripeEvent = jest.fn();
const mockReleaseStripeEvent = jest.fn();

jest.mock("@/utils/stripe/processed-events", () => ({
  claimStripeEvent: (...args: any[]) => mockClaimStripeEvent(...args),
  finalizeStripeEvent: (...args: any[]) => mockFinalizeStripeEvent(...args),
  releaseStripeEvent: (...args: any[]) => mockReleaseStripeEvent(...args),
}));

jest.mock("@/utils/stripe/pending-payments", () => ({
  markPendingPaymentByIntent: jest.fn(async () => undefined),
}));

import subscriptionWebhookHandler from "@/pages/api/stripe/subscription-webhook";
import webhookHandler from "@/pages/api/stripe/webhook";

const SUB_ID = "sub_connected_123";
const CONNECTED_ACCOUNT = "acct_seller_connected";

function makeReq() {
  return {
    method: "POST",
    headers: { "stripe-signature": "test-sig" },
    on(event: string, cb: (arg?: unknown) => void) {
      if (event === "end") cb();
      return this;
    },
  } as any;
}

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

const originalSubSecret = process.env.STRIPE_SUBSCRIPTION_WEBHOOK_SECRET;
const originalSecret = process.env.STRIPE_WEBHOOK_SECRET;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.STRIPE_SUBSCRIPTION_WEBHOOK_SECRET = "whsec_sub_test";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  mockClaimStripeEvent.mockResolvedValue(true);
  mockFinalizeStripeEvent.mockResolvedValue(undefined);
  mockReleaseStripeEvent.mockResolvedValue(undefined);
  mockSubscriptionsRetrieve.mockResolvedValue({
    id: SUB_ID,
    status: "active",
    current_period_end: 1700000000,
    metadata: {},
  });
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore?.();
  (console.warn as jest.Mock).mockRestore?.();
});

afterAll(() => {
  process.env.STRIPE_SUBSCRIPTION_WEBHOOK_SECRET = originalSubSecret;
  process.env.STRIPE_WEBHOOK_SECRET = originalSecret;
});

describe("POST /api/stripe/subscription-webhook — invoice.payment_succeeded", () => {
  function firePaymentSucceeded() {
    mockConstructEvent.mockReturnValue({
      id: "evt_renewal",
      type: "invoice.payment_succeeded",
      data: {
        object: {
          id: "in_renewal",
          subscription: SUB_ID,
          billing_reason: "subscription_cycle",
        },
      },
    });
  }

  it("retrieves the subscription from the recorded connected account", async () => {
    mockGetSubscriptionByStripeId.mockResolvedValue({
      stripe_subscription_id: SUB_ID,
      seller_pubkey: "b".repeat(64),
      buyer_pubkey: null,
      buyer_email: "buyer@example.com",
      status: "active",
      connected_account_id: CONNECTED_ACCOUNT,
      currency: "usd",
    });
    firePaymentSucceeded();

    const res = makeRes();
    await subscriptionWebhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(mockSubscriptionsRetrieve).toHaveBeenCalledWith(SUB_ID, {
      stripeAccount: CONNECTED_ACCOUNT,
    });
    expect(mockUpdateSubscriptionBillingDate).toHaveBeenCalled();
  });

  it("retrieves from the platform account when the row has no connected account", async () => {
    mockGetSubscriptionByStripeId.mockResolvedValue({
      stripe_subscription_id: SUB_ID,
      seller_pubkey: "b".repeat(64),
      buyer_pubkey: null,
      buyer_email: "buyer@example.com",
      status: "active",
      connected_account_id: null,
      currency: "usd",
    });
    firePaymentSucceeded();

    const res = makeRes();
    await subscriptionWebhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(mockSubscriptionsRetrieve).toHaveBeenCalledWith(SUB_ID, undefined);
    expect(mockUpdateSubscriptionBillingDate).toHaveBeenCalled();
  });
});

describe("POST /api/stripe/webhook — invoice.paid (handleInvoicePaid)", () => {
  function fireInvoicePaid() {
    mockConstructEvent.mockReturnValue({
      id: "evt_invoice_paid",
      type: "invoice.paid",
      data: {
        object: {
          id: "in_paid",
          subscription: SUB_ID,
          currency: "usd",
        },
      },
    });
  }

  it("looks up the row and retrieves the subscription from the recorded connected account", async () => {
    mockGetSubscriptionByStripeId.mockResolvedValue({
      stripe_subscription_id: SUB_ID,
      seller_pubkey: "b".repeat(64),
      connected_account_id: CONNECTED_ACCOUNT,
    });
    fireInvoicePaid();

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(mockGetSubscriptionByStripeId).toHaveBeenCalledWith(SUB_ID);
    expect(mockSubscriptionsRetrieve).toHaveBeenCalledWith(SUB_ID, {
      stripeAccount: CONNECTED_ACCOUNT,
    });
  });

  it("retrieves from the platform account when no row exists (platform subscription)", async () => {
    mockGetSubscriptionByStripeId.mockResolvedValue(null);
    fireInvoicePaid();

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(mockSubscriptionsRetrieve).toHaveBeenCalledWith(SUB_ID, undefined);
  });

  it("still retrieves from the platform account when the DB lookup fails", async () => {
    mockGetSubscriptionByStripeId.mockRejectedValue(new Error("db down"));
    fireInvoicePaid();

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(mockSubscriptionsRetrieve).toHaveBeenCalledWith(SUB_ID, undefined);
  });
});
