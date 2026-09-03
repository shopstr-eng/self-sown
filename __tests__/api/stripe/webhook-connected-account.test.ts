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
import {
  sendRenewalReminder,
  sendSubscriptionCancellation,
} from "@/utils/email/email-service";

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
const originalSubConnectSecret =
  process.env.STRIPE_SUBSCRIPTION_CONNECT_WEBHOOK_SECRET;
const originalConnectSecret = process.env.STRIPE_WEBHOOK_CONNECT_SECRET;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.STRIPE_SUBSCRIPTION_WEBHOOK_SECRET = "whsec_sub_test";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  delete process.env.STRIPE_SUBSCRIPTION_CONNECT_WEBHOOK_SECRET;
  delete process.env.STRIPE_WEBHOOK_CONNECT_SECRET;
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
  process.env.STRIPE_SUBSCRIPTION_CONNECT_WEBHOOK_SECRET =
    originalSubConnectSecret;
  process.env.STRIPE_WEBHOOK_CONNECT_SECRET = originalConnectSecret;
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

// Each webhook URL is fronted by two Stripe endpoints (account-scoped +
// Connect), each signing with its own secret, so handlers must accept either.
describe("dual signing-secret verification (account + Connect endpoints)", () => {
  const EVENT = {
    id: "evt_dual",
    type: "invoice.payment_succeeded",
    data: { object: { id: "in_dual", subscription: null } },
  };

  it("subscription-webhook accepts the Connect secret when the primary fails", async () => {
    process.env.STRIPE_SUBSCRIPTION_CONNECT_WEBHOOK_SECRET = "whsec_sub_conn";
    mockConstructEvent
      .mockImplementationOnce(() => {
        throw new Error("primary secret mismatch");
      })
      .mockReturnValueOnce(EVENT);

    const res = makeRes();
    await subscriptionWebhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(mockConstructEvent).toHaveBeenCalledTimes(2);
    expect(mockConstructEvent.mock.calls[1][2]).toBe("whsec_sub_conn");
  });

  it("webhook accepts the Connect secret when the primary fails", async () => {
    process.env.STRIPE_WEBHOOK_CONNECT_SECRET = "whsec_conn";
    mockConstructEvent
      .mockImplementationOnce(() => {
        throw new Error("primary secret mismatch");
      })
      .mockReturnValueOnce({
        id: "evt_dual_main",
        type: "invoice.paid",
        data: { object: { id: "in_dual2", subscription: null } },
      });

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(mockConstructEvent).toHaveBeenCalledTimes(2);
    expect(mockConstructEvent.mock.calls[1][2]).toBe("whsec_conn");
  });

  it("rejects when no configured secret verifies the signature", async () => {
    mockConstructEvent.mockImplementation(() => {
      throw new Error("bad signature");
    });

    const res = makeRes();
    await subscriptionWebhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(400);
  });

  it("500s when no secrets are configured at all", async () => {
    delete process.env.STRIPE_SUBSCRIPTION_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;

    const subRes = makeRes();
    await subscriptionWebhookHandler(makeReq(), subRes);
    expect(subRes.statusCode).toBe(500);
    expect(subRes.body).toEqual({ error: "Webhook secret not configured" });
    expect(mockConstructEvent).not.toHaveBeenCalled();

    const mainRes = makeRes();
    await webhookHandler(makeReq(), mainRes);
    expect(mainRes.statusCode).toBe(500);
    expect(mainRes.body).toEqual({ error: "Webhook secret not configured" });
  });
});

// A paid renewal whose lookup finds no row must be loud (ops reconciliation),
// while a transient DB failure must 500 so Stripe retries — never silently
// break with a 200 in either case.
describe("POST /api/stripe/subscription-webhook — orphaned/failed renewal lookup", () => {
  function firePaymentSucceeded() {
    mockConstructEvent.mockReturnValue({
      id: "evt_orphan",
      type: "invoice.payment_succeeded",
      data: {
        object: {
          id: "in_orphan",
          subscription: SUB_ID,
          billing_reason: "subscription_cycle",
          amount_paid: 1000,
          currency: "usd",
          customer_email: "buyer@example.com",
        },
      },
    });
  }

  it("logs a loud greppable marker and still 200s when no subscriptions row matches a paid renewal", async () => {
    mockGetSubscriptionByStripeId.mockResolvedValue(null);
    firePaymentSucceeded();

    const res = makeRes();
    await subscriptionWebhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    const errCalls = (console.error as jest.Mock).mock.calls
      .map((args) => String(args[0]))
      .join("\n");
    expect(errCalls).toContain("ORPHANED_SUBSCRIPTION_PAYMENT");
    expect(errCalls).toContain(SUB_ID);
    expect(errCalls).toContain("buyer@example.com");
    // No local state may be touched for a row that does not exist.
    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled();
    expect(mockUpdateSubscriptionBillingDate).not.toHaveBeenCalled();
    expect(mockUpdateSubscriptionStatus).not.toHaveBeenCalled();
    // Nothing to retry — the row will never appear — so the claim stays.
    expect(mockReleaseStripeEvent).not.toHaveBeenCalled();
  });

  it("500s and releases the event claim when the lookup throws, so Stripe retries", async () => {
    mockGetSubscriptionByStripeId.mockRejectedValue(new Error("db down"));
    firePaymentSucceeded();

    const res = makeRes();
    await subscriptionWebhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(500);
    expect(mockReleaseStripeEvent).toHaveBeenCalledWith("evt_orphan");
    expect(mockUpdateSubscriptionBillingDate).not.toHaveBeenCalled();
    // A transient failure is NOT an orphaned payment.
    const errCalls = (console.error as jest.Mock).mock.calls
      .map((args) => String(args[0]))
      .join("\n");
    expect(errCalls).not.toContain("ORPHANED_SUBSCRIPTION_PAYMENT");
  });
});

// A cancellation whose lookup finds no row still 200s (no useful retry) but
// must be loud: otherwise the buyer keeps believing they are subscribed and
// the seller dashboard can keep showing the sub as active.
describe("POST /api/stripe/subscription-webhook — orphaned cancellation", () => {
  function fireSubscriptionDeleted() {
    mockConstructEvent.mockReturnValue({
      id: "evt_orphan_cancel",
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: SUB_ID,
          customer: "cus_orphan",
          status: "canceled",
          current_period_end: 1700000000,
        },
      },
    });
  }

  it("logs a loud greppable marker and still 200s when no subscriptions row matches a cancellation", async () => {
    mockGetSubscriptionByStripeId.mockResolvedValue(null);
    fireSubscriptionDeleted();

    const res = makeRes();
    await subscriptionWebhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    const errCalls = (console.error as jest.Mock).mock.calls
      .map((args) => String(args[0]))
      .join("\n");
    expect(errCalls).toContain("ORPHANED_SUBSCRIPTION_CANCEL");
    expect(errCalls).toContain(SUB_ID);
    expect(errCalls).toContain("evt_orphan_cancel");
    // No buyer notification may be faked for a row that does not exist.
    expect(sendSubscriptionCancellation).not.toHaveBeenCalled();
    expect(mockCreateSubscriptionNotification).not.toHaveBeenCalled();
    // Nothing to retry — the row will never appear — so the claim stays.
    expect(mockReleaseStripeEvent).not.toHaveBeenCalled();
  });

  it("500s and releases the event claim when the lookup throws, so Stripe retries", async () => {
    mockGetSubscriptionByStripeId.mockRejectedValue(new Error("db down"));
    fireSubscriptionDeleted();

    const res = makeRes();
    await subscriptionWebhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(500);
    expect(mockReleaseStripeEvent).toHaveBeenCalledWith("evt_orphan_cancel");
    expect(sendSubscriptionCancellation).not.toHaveBeenCalled();
    // A transient failure is NOT an orphaned cancellation.
    const errCalls = (console.error as jest.Mock).mock.calls
      .map((args) => String(args[0]))
      .join("\n");
    expect(errCalls).not.toContain("ORPHANED_SUBSCRIPTION_CANCEL");
  });

  it("does not log the orphan marker when the row exists", async () => {
    mockGetSubscriptionByStripeId.mockResolvedValue({
      id: "local-sub-1",
      stripe_subscription_id: SUB_ID,
      seller_pubkey: "b".repeat(64),
      buyer_pubkey: null,
      buyer_email: "buyer@example.com",
      product_title: "Test product",
      product_event_id: "prod_1",
    });
    fireSubscriptionDeleted();

    const res = makeRes();
    await subscriptionWebhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(sendSubscriptionCancellation).toHaveBeenCalled();
    const errCalls = (console.error as jest.Mock).mock.calls
      .map((args) => String(args[0]))
      .join("\n");
    expect(errCalls).not.toContain("ORPHANED_SUBSCRIPTION_CANCEL");
  });
});

// A renewal reminder whose lookup finds no row silently never warns the buyer
// about the upcoming charge — it must be loud instead.
describe("POST /api/stripe/subscription-webhook — orphaned renewal reminder", () => {
  function fireInvoiceUpcoming() {
    mockConstructEvent.mockReturnValue({
      id: "evt_orphan_reminder",
      type: "invoice.upcoming",
      data: {
        object: {
          id: "in_upcoming",
          subscription: SUB_ID,
          customer_email: "buyer@example.com",
        },
      },
    });
  }

  it("logs a loud greppable marker and still 200s when no subscriptions row matches an upcoming invoice", async () => {
    mockGetSubscriptionByStripeId.mockResolvedValue(null);
    fireInvoiceUpcoming();

    const res = makeRes();
    await subscriptionWebhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    const errCalls = (console.error as jest.Mock).mock.calls
      .map((args) => String(args[0]))
      .join("\n");
    expect(errCalls).toContain("ORPHANED_SUBSCRIPTION_REMINDER");
    expect(errCalls).toContain(SUB_ID);
    expect(errCalls).toContain("evt_orphan_reminder");
    // No reminder may be faked for a row that does not exist.
    expect(sendRenewalReminder).not.toHaveBeenCalled();
    expect(mockCreateSubscriptionNotification).not.toHaveBeenCalled();
    // Nothing to retry — the row will never appear — so the claim stays.
    expect(mockReleaseStripeEvent).not.toHaveBeenCalled();
  });

  it("500s and releases the event claim when the lookup throws, so Stripe retries", async () => {
    mockGetSubscriptionByStripeId.mockRejectedValue(new Error("db down"));
    fireInvoiceUpcoming();

    const res = makeRes();
    await subscriptionWebhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(500);
    expect(mockReleaseStripeEvent).toHaveBeenCalledWith("evt_orphan_reminder");
    expect(sendRenewalReminder).not.toHaveBeenCalled();
    // A transient failure is NOT an orphaned reminder.
    const errCalls = (console.error as jest.Mock).mock.calls
      .map((args) => String(args[0]))
      .join("\n");
    expect(errCalls).not.toContain("ORPHANED_SUBSCRIPTION_REMINDER");
  });
});
