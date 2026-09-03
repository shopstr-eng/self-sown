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

const mockSendOrphanedSubscriptionPaymentAlert = jest.fn(
  async (..._args: any[]) => true
);
const mockSendOrphanedSubscriptionCancellationAlert = jest.fn(
  async (..._args: any[]) => true
);

jest.mock("@/utils/email/email-service", () => ({
  // The real helper resolves a delivery boolean — it does not throw.
  sendRenewalReminder: jest.fn(async () => true),
  sendSubscriptionCancellation: jest.fn(async () => undefined),
  sendPaymentFailedToBuyer: jest.fn(async () => undefined),
  sendPaymentFailedToSeller: jest.fn(async () => undefined),
  sendTransferFailureAlert: jest.fn(async () => undefined),
  sendOrphanedSubscriptionPaymentAlert: (...args: any[]) =>
    mockSendOrphanedSubscriptionPaymentAlert(...args),
  sendOrphanedSubscriptionCancellationAlert: (...args: any[]) =>
    mockSendOrphanedSubscriptionCancellationAlert(...args),
}));

jest.mock("@/utils/nostr/server-nostr-helpers", () => ({
  // The real helper resolves a delivery boolean — it does not throw.
  sendServerSideNostrDM: jest.fn(async () => true),
}));

jest.mock("@/utils/email/storefront-branding", () => ({
  loadStorefrontBranding: jest.fn(async () => null),
}));

const mockReverseReferralsForOrder = jest.fn(
  async (..._args: any[]) => undefined
);

jest.mock("@/utils/db/affiliates", () => ({
  computeRebateSmallest: jest.fn(() => 0),
  isAffiliateCodeValid: jest.fn(async () => false),
  lookupAffiliateCode: jest.fn(async () => null),
  recordReferral: jest.fn(async () => undefined),
  reverseReferralsForOrder: (...args: any[]) =>
    mockReverseReferralsForOrder(...args),
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

const mockUpdateMcpOrderPayment = jest.fn();
const mockAutoPurchaseForMcpOrder = jest.fn(
  async (..._args: any[]) => undefined
);

jest.mock("@/mcp/tools/purchase-tools", () => ({
  updateMcpOrderPayment: (...args: any[]) => mockUpdateMcpOrderPayment(...args),
}));

const mockProSettingsStore = new Map<string, string>();
const mockGetProSetting = jest.fn(async (...args: any[]) => {
  const value = mockProSettingsStore.get(args[0] as string);
  return value === undefined ? null : value;
});
const mockSetProSetting = jest.fn(async (...args: any[]) => {
  mockProSettingsStore.set(args[0] as string, args[1] as string);
});
// Serialize per key like the real pg advisory lock so concurrency tests
// genuinely exercise the mutual exclusion.
const mockProSettingsLocks = new Map<string, Promise<unknown>>();
const mockWithProSettingsLock = jest.fn(
  <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = mockProSettingsLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockProSettingsLocks.set(
      key,
      prev.catch(() => {}).then(() => current)
    );
    return prev.catch(() => {}).then(async () => {
      try {
        return await fn();
      } finally {
        release();
      }
    });
  }
);

jest.mock("@/utils/db/pro-membership", () => ({
  getProSetting: (...args: any[]) => mockGetProSetting(...args),
  setProSetting: (...args: any[]) => mockSetProSetting(...args),
  withProSettingsLock: (key: string, fn: () => Promise<unknown>) =>
    mockWithProSettingsLock(key, fn),
}));

jest.mock("@/utils/shipping/auto-purchase", () => ({
  autoPurchaseForMcpOrder: (...args: any[]) =>
    mockAutoPurchaseForMcpOrder(...args),
}));

import subscriptionWebhookHandler from "@/pages/api/stripe/subscription-webhook";
import webhookHandler from "@/pages/api/stripe/webhook";
import {
  sendRenewalReminder,
  sendSubscriptionCancellation,
  sendPaymentFailedToSeller,
} from "@/utils/email/email-service";
import { sendServerSideNostrDM } from "@/utils/nostr/server-nostr-helpers";

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
  mockProSettingsStore.clear();
  mockProSettingsLocks.clear();
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

  it("500s and releases the event claim when the DB lookup throws, so Stripe retries", async () => {
    // A lookup outage must NOT be swallowed as "no row": falling back to a
    // platform-account retrieve would misfile a connected-account renewal as
    // orphaned. Fail instead and let Stripe retry once the DB recovers.
    mockGetSubscriptionByStripeId.mockRejectedValue(new Error("db down"));
    fireInvoicePaid();

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(500);
    expect(mockReleaseStripeEvent).toHaveBeenCalledWith("evt_invoice_paid");
    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled();
    const errCalls = (console.error as jest.Mock).mock.calls
      .map((args) => String(args[0]))
      .join("\n");
    expect(errCalls).not.toContain("ORPHANED_SUBSCRIPTION_INVOICE_PAID");
  });

  it("logs ORPHANED_SUBSCRIPTION_INVOICE_PAID and still 200s when no row matches AND the platform account cannot see the subscription", async () => {
    // Money moved on a connected account we have no record of: the retrieve
    // without { stripeAccount } fails resource_missing, the seller transfers
    // can never run, and retrying will never find the row — so 200 + loud.
    mockGetSubscriptionByStripeId.mockResolvedValue(null);
    mockSubscriptionsRetrieve.mockRejectedValue(
      Object.assign(new Error("No such subscription"), {
        code: "resource_missing",
        statusCode: 404,
      })
    );
    fireInvoicePaid();

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    const errCalls = (console.error as jest.Mock).mock.calls
      .map((args) => String(args[0]))
      .join("\n");
    expect(errCalls).toContain("ORPHANED_SUBSCRIPTION_INVOICE_PAID");
    expect(errCalls).toContain(SUB_ID);
    expect(errCalls).toContain("evt_invoice_paid");
    // Nothing to retry — the row will never appear — so the claim stays.
    expect(mockReleaseStripeEvent).not.toHaveBeenCalled();
  });

  it("still 500s when the platform retrieve fails for a non-orphan reason", async () => {
    mockGetSubscriptionByStripeId.mockResolvedValue(null);
    mockSubscriptionsRetrieve.mockRejectedValue(new Error("stripe 500"));
    fireInvoicePaid();

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(500);
    expect(mockReleaseStripeEvent).toHaveBeenCalledWith("evt_invoice_paid");
    const errCalls = (console.error as jest.Mock).mock.calls
      .map((args) => String(args[0]))
      .join("\n");
    expect(errCalls).not.toContain("ORPHANED_SUBSCRIPTION_INVOICE_PAID");
  });

  it("does not log the orphan marker when a row exists and the retrieve succeeds", async () => {
    mockGetSubscriptionByStripeId.mockResolvedValue({
      stripe_subscription_id: SUB_ID,
      seller_pubkey: "b".repeat(64),
      connected_account_id: null,
    });
    fireInvoicePaid();

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    const errCalls = (console.error as jest.Mock).mock.calls
      .map((args) => String(args[0]))
      .join("\n");
    expect(errCalls).not.toContain("ORPHANED_SUBSCRIPTION_INVOICE_PAID");
  });

  // Connect events carry the delivering connected account on event.account;
  // with no local row the retrieve must be scoped to it rather than the
  // platform account, or a valid connected subscription would be misfiled as
  // an orphan and its transfers skipped.
  function fireConnectInvoicePaid() {
    mockConstructEvent.mockReturnValue({
      id: "evt_invoice_paid_connect",
      type: "invoice.paid",
      account: CONNECTED_ACCOUNT,
      data: {
        object: {
          id: "in_paid_connect",
          subscription: SUB_ID,
          currency: "usd",
        },
      },
    });
  }

  it("scopes the retrieve to event.account when no local row matches a Connect invoice.paid", async () => {
    mockGetSubscriptionByStripeId.mockResolvedValue(null);
    fireConnectInvoicePaid();

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(mockSubscriptionsRetrieve).toHaveBeenCalledWith(SUB_ID, {
      stripeAccount: CONNECTED_ACCOUNT,
    });
    const errCalls = (console.error as jest.Mock).mock.calls
      .map((args) => String(args[0]))
      .join("\n");
    expect(errCalls).not.toContain("ORPHANED_SUBSCRIPTION_INVOICE_PAID");
  });

  it("logs the orphan marker only after the Connect-scoped retrieve also fails", async () => {
    mockGetSubscriptionByStripeId.mockResolvedValue(null);
    mockSubscriptionsRetrieve.mockRejectedValue(
      Object.assign(new Error("No such subscription"), {
        code: "resource_missing",
        statusCode: 404,
      })
    );
    fireConnectInvoicePaid();

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(mockSubscriptionsRetrieve).toHaveBeenCalledWith(SUB_ID, {
      stripeAccount: CONNECTED_ACCOUNT,
    });
    const errCalls = (console.error as jest.Mock).mock.calls
      .map((args) => String(args[0]))
      .join("\n");
    expect(errCalls).toContain("ORPHANED_SUBSCRIPTION_INVOICE_PAID");
    expect(errCalls).toContain(CONNECTED_ACCOUNT);
    expect(mockReleaseStripeEvent).not.toHaveBeenCalled();
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

  it("logs a loud greppable marker, alerts ops, and still 200s when no subscriptions row matches a paid renewal", async () => {
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
    // Ops must be alerted with the reconciliation details, not just logged.
    expect(mockSendOrphanedSubscriptionPaymentAlert).toHaveBeenCalledTimes(1);
    expect(mockSendOrphanedSubscriptionPaymentAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeSubscriptionId: SUB_ID,
        invoiceId: "in_orphan",
        eventId: "evt_orphan",
        amountPaid: "1000",
        currency: "usd",
        customerEmail: "buyer@example.com",
      })
    );
    // No local state may be touched for a row that does not exist.
    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled();
    expect(mockUpdateSubscriptionBillingDate).not.toHaveBeenCalled();
    expect(mockUpdateSubscriptionStatus).not.toHaveBeenCalled();
    // Nothing to retry — the row will never appear — so the claim stays.
    expect(mockReleaseStripeEvent).not.toHaveBeenCalled();
  });

  it("still 200s when the ops alert email itself throws — the row will never appear on retry", async () => {
    mockGetSubscriptionByStripeId.mockResolvedValue(null);
    mockSendOrphanedSubscriptionPaymentAlert.mockRejectedValueOnce(
      new Error("sendgrid down")
    );
    firePaymentSucceeded();

    const res = makeRes();
    await subscriptionWebhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(mockSendOrphanedSubscriptionPaymentAlert).toHaveBeenCalledTimes(1);
    expect(mockReleaseStripeEvent).not.toHaveBeenCalled();
  });

  it("stamps the dedup key only after a successful send, so a live legacy subscription alerts at most once per day", async () => {
    mockGetSubscriptionByStripeId.mockResolvedValue(null);
    firePaymentSucceeded();

    const res = makeRes();
    await subscriptionWebhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(mockSendOrphanedSubscriptionPaymentAlert).toHaveBeenCalledTimes(1);
    expect(mockSetProSetting).toHaveBeenCalledWith(
      `orphaned_subscription_payment_alert:${SUB_ID}`,
      expect.any(String)
    );

    // A second event for the SAME subscription inside the cooldown window is
    // logged but does not re-email ops (the first send stamped the store).
    mockSendOrphanedSubscriptionPaymentAlert.mockClear();
    firePaymentSucceeded();

    const res2 = makeRes();
    await subscriptionWebhookHandler(makeReq(), res2);

    expect(res2.statusCode).toBe(200);
    expect(mockSendOrphanedSubscriptionPaymentAlert).not.toHaveBeenCalled();
    expect(mockSetProSetting).toHaveBeenCalledTimes(1);
    const warnCalls = (console.warn as jest.Mock).mock.calls
      .map((args) => String(args[0]))
      .join("\n");
    expect(warnCalls).toContain(
      "ORPHANED_SUBSCRIPTION_PAYMENT_ALERT_SUPPRESSED"
    );
  });

  it("re-alerts when the previous send failed (no dedup stamp) and for a genuinely different orphaned subscription", async () => {
    mockGetSubscriptionByStripeId.mockResolvedValue(null);

    // Send failed last time → nothing was stamped → alert again.
    mockSendOrphanedSubscriptionPaymentAlert.mockResolvedValueOnce(false);
    firePaymentSucceeded();
    await subscriptionWebhookHandler(makeReq(), makeRes());
    expect(mockSetProSetting).not.toHaveBeenCalled();

    firePaymentSucceeded();
    await subscriptionWebhookHandler(makeReq(), makeRes());
    expect(mockSendOrphanedSubscriptionPaymentAlert).toHaveBeenCalledTimes(2);

    // A different orphaned subscription has its own dedup key and must still
    // alert even though SUB_ID was stamped by the successful send above.
    mockSendOrphanedSubscriptionPaymentAlert.mockClear();
    mockConstructEvent.mockReturnValue({
      id: "evt_orphan_other",
      type: "invoice.payment_succeeded",
      data: {
        object: {
          id: "in_orphan_other",
          subscription: "sub_other_orphan",
          billing_reason: "subscription_cycle",
          amount_paid: 2000,
          currency: "usd",
          customer_email: "other@example.com",
        },
      },
    });

    const res = makeRes();
    await subscriptionWebhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(mockSendOrphanedSubscriptionPaymentAlert).toHaveBeenCalledTimes(1);
    expect(mockSendOrphanedSubscriptionPaymentAlert).toHaveBeenCalledWith(
      expect.objectContaining({ stripeSubscriptionId: "sub_other_orphan" })
    );
    expect(mockSetProSetting).toHaveBeenCalledWith(
      "orphaned_subscription_payment_alert:sub_other_orphan",
      expect.any(String)
    );
  });

  it("re-alerts after the 24h cooldown expires for the same orphaned subscription", async () => {
    mockGetSubscriptionByStripeId.mockResolvedValue(null);
    mockProSettingsStore.set(
      `orphaned_subscription_payment_alert:${SUB_ID}`,
      new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    );
    firePaymentSucceeded();

    const res = makeRes();
    await subscriptionWebhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(mockSendOrphanedSubscriptionPaymentAlert).toHaveBeenCalledTimes(1);
  });

  it("sends only one alert when two distinct events for the same orphaned subscription arrive concurrently", async () => {
    mockGetSubscriptionByStripeId.mockResolvedValue(null);

    // Hold the first send open so the second event enters the race window
    // before either handler can stamp the dedup key.
    let resolveSend!: (sent: boolean) => void;
    mockSendOrphanedSubscriptionPaymentAlert.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSend = resolve;
        })
    );

    const orphanEvent = (eventId: string, invoiceId: string) => ({
      id: eventId,
      type: "invoice.payment_succeeded",
      data: {
        object: {
          id: invoiceId,
          subscription: SUB_ID,
          billing_reason: "subscription_cycle",
          amount_paid: 1000,
          currency: "usd",
          customer_email: "buyer@example.com",
        },
      },
    });
    mockConstructEvent.mockReturnValueOnce(
      orphanEvent("evt_orphan_a", "in_orphan_a") as any
    );
    const resA = makeRes();
    const handlerA = subscriptionWebhookHandler(makeReq(), resA);

    // Wait until handler A is inside the send, then fire event B — it must
    // queue on the per-subscription lock instead of double-sending.
    for (
      let i = 0;
      i < 100 && mockSendOrphanedSubscriptionPaymentAlert.mock.calls.length === 0;
      i++
    ) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(mockSendOrphanedSubscriptionPaymentAlert).toHaveBeenCalledTimes(1);

    mockConstructEvent.mockReturnValueOnce(
      orphanEvent("evt_orphan_b", "in_orphan_b") as any
    );
    const resB = makeRes();
    const handlerB = subscriptionWebhookHandler(makeReq(), resB);
    await new Promise((resolve) => setImmediate(resolve));

    resolveSend(true);
    await Promise.all([handlerA, handlerB]);

    expect(resA.statusCode).toBe(200);
    expect(resB.statusCode).toBe(200);
    // B observed A's stamp after the lock and suppressed its own alert.
    expect(mockSendOrphanedSubscriptionPaymentAlert).toHaveBeenCalledTimes(1);
    expect(mockSetProSetting).toHaveBeenCalledTimes(1);
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

  it("logs a loud greppable marker, alerts ops, and still 200s when no subscriptions row matches a cancellation", async () => {
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
    // Ops must be alerted with the reconciliation details, not just logged.
    expect(mockSendOrphanedSubscriptionCancellationAlert).toHaveBeenCalledTimes(
      1
    );
    expect(mockSendOrphanedSubscriptionCancellationAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeSubscriptionId: SUB_ID,
        eventId: "evt_orphan_cancel",
        customer: "cus_orphan",
        status: "canceled",
      })
    );
    // No buyer notification may be faked for a row that does not exist.
    expect(sendSubscriptionCancellation).not.toHaveBeenCalled();
    expect(mockCreateSubscriptionNotification).not.toHaveBeenCalled();
    // Nothing to retry — the row will never appear — so the claim stays.
    expect(mockReleaseStripeEvent).not.toHaveBeenCalled();
  });

  it("still 200s when the ops alert email itself throws — the row will never appear on retry", async () => {
    mockGetSubscriptionByStripeId.mockResolvedValue(null);
    mockSendOrphanedSubscriptionCancellationAlert.mockRejectedValueOnce(
      new Error("sendgrid down")
    );
    fireSubscriptionDeleted();

    const res = makeRes();
    await subscriptionWebhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(mockSendOrphanedSubscriptionCancellationAlert).toHaveBeenCalledTimes(
      1
    );
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

// Happy path: the subscriptions row exists, so the buyer must actually be
// reminded — by email always, and by Nostr DM too when buyer_pubkey is set —
// and a subscription_notifications row must record what was sent.
describe("POST /api/stripe/subscription-webhook — renewal reminder sent", () => {
  const SELLER_PUBKEY = "b".repeat(64);
  const BUYER_PUBKEY = "a".repeat(64);
  const NEXT_BILLING = "2026-10-15T12:00:00.000Z";
  const NEXT_BILLING_FORMATTED = "October 15, 2026";

  function fireInvoiceUpcoming() {
    mockConstructEvent.mockReturnValue({
      id: "evt_reminder_ok",
      type: "invoice.upcoming",
      data: {
        object: {
          id: "in_upcoming_ok",
          subscription: SUB_ID,
          customer_email: "buyer@example.com",
        },
      },
    });
  }

  function makeSubscriptionRow(
    overrides: Partial<Record<string, unknown>> = {}
  ) {
    return {
      id: 42,
      stripe_subscription_id: SUB_ID,
      seller_pubkey: SELLER_PUBKEY,
      buyer_pubkey: BUYER_PUBKEY,
      buyer_email: "buyer@example.com",
      product_title: "Grass-Fed Beef Box",
      product_event_id: "prod_evt_1",
      frequency: "monthly",
      discount_percent: 10,
      base_price: 100,
      subscription_price: 90,
      currency: "usd",
      next_billing_date: NEXT_BILLING,
      status: "active",
      ...overrides,
    };
  }

  it("emails the buyer and sends a Nostr DM when buyer_pubkey is set, recording method 'both'", async () => {
    mockGetSubscriptionByStripeId.mockResolvedValue(makeSubscriptionRow());
    fireInvoiceUpcoming();

    const res = makeRes();
    await subscriptionWebhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(sendRenewalReminder).toHaveBeenCalledTimes(1);
    expect(sendRenewalReminder).toHaveBeenCalledWith(
      "buyer@example.com",
      {
        productTitle: "Grass-Fed Beef Box",
        frequency: "monthly",
        discountPercent: 10,
        regularPrice: "100",
        subscriptionPrice: "90",
        currency: "usd",
        nextBillingDate: NEXT_BILLING_FORMATTED,
      },
      null // loadStorefrontBranding is mocked to return null
    );
    expect(sendServerSideNostrDM).toHaveBeenCalledTimes(1);
    expect(sendServerSideNostrDM).toHaveBeenCalledWith(
      BUYER_PUBKEY,
      expect.stringContaining("Grass-Fed Beef Box"),
      "subscription-renewal"
    );
    const dmMessage = (sendServerSideNostrDM as jest.Mock).mock.calls[0][1];
    expect(dmMessage).toContain(NEXT_BILLING_FORMATTED);
    expect(dmMessage).toContain("90 USD");
    expect(mockCreateSubscriptionNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateSubscriptionNotification).toHaveBeenCalledWith({
      subscription_id: 42,
      type: "renewal_reminder",
      method: "both",
    });
  });

  it("sends email only when buyer_pubkey is null, recording method 'email', and falls back to product_event_id when the title is missing", async () => {
    mockGetSubscriptionByStripeId.mockResolvedValue(
      makeSubscriptionRow({ buyer_pubkey: null, product_title: null })
    );
    fireInvoiceUpcoming();

    const res = makeRes();
    await subscriptionWebhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(sendRenewalReminder).toHaveBeenCalledTimes(1);
    expect(sendRenewalReminder).toHaveBeenCalledWith(
      "buyer@example.com",
      expect.objectContaining({
        productTitle: "prod_evt_1",
        nextBillingDate: NEXT_BILLING_FORMATTED,
      }),
      null
    );
    // No Nostr identity to DM.
    expect(sendServerSideNostrDM).not.toHaveBeenCalled();
    expect(mockCreateSubscriptionNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateSubscriptionNotification).toHaveBeenCalledWith({
      subscription_id: 42,
      type: "renewal_reminder",
      method: "email",
    });
  });

  it("records no notification row when the email send rejects and there is no Nostr identity", async () => {
    mockGetSubscriptionByStripeId.mockResolvedValue(
      makeSubscriptionRow({ buyer_pubkey: null })
    );
    (sendRenewalReminder as jest.Mock).mockRejectedValueOnce(
      new Error("smtp down")
    );
    fireInvoiceUpcoming();

    const res = makeRes();
    await subscriptionWebhookHandler(makeReq(), res);

    // Still 200 — retrying will not fix a down mail relay, but the failure
    // must NOT be recorded as a sent reminder.
    expect(res.statusCode).toBe(200);
    expect(sendRenewalReminder).toHaveBeenCalledTimes(1);
    expect(mockCreateSubscriptionNotification).not.toHaveBeenCalled();
    const errCalls = (console.error as jest.Mock).mock.calls
      .map((args) => String(args[0]))
      .join("\n");
    expect(errCalls).toContain("RENEWAL_REMINDER_DELIVERY_FAILED");
    expect(errCalls).toContain("evt_reminder_ok");
  });

  it("records only 'email' (not 'both') when the Nostr DM rejects with buyer_pubkey set", async () => {
    mockGetSubscriptionByStripeId.mockResolvedValue(makeSubscriptionRow());
    (sendServerSideNostrDM as jest.Mock).mockRejectedValueOnce(
      new Error("relay down")
    );
    fireInvoiceUpcoming();

    const res = makeRes();
    await subscriptionWebhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(sendServerSideNostrDM).toHaveBeenCalledTimes(1);
    expect(mockCreateSubscriptionNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateSubscriptionNotification).toHaveBeenCalledWith({
      subscription_id: 42,
      type: "renewal_reminder",
      method: "email",
    });
  });

  it("records only 'email' (not 'both') when the Nostr DM resolves false", async () => {
    mockGetSubscriptionByStripeId.mockResolvedValue(makeSubscriptionRow());
    (sendServerSideNostrDM as jest.Mock).mockResolvedValueOnce(false);
    fireInvoiceUpcoming();

    const res = makeRes();
    await subscriptionWebhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(mockCreateSubscriptionNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateSubscriptionNotification).toHaveBeenCalledWith({
      subscription_id: 42,
      type: "renewal_reminder",
      method: "email",
    });
  });

  it("records only 'nostr' when the email send rejects but the DM succeeds", async () => {
    mockGetSubscriptionByStripeId.mockResolvedValue(makeSubscriptionRow());
    (sendRenewalReminder as jest.Mock).mockRejectedValueOnce(
      new Error("smtp down")
    );
    fireInvoiceUpcoming();

    const res = makeRes();
    await subscriptionWebhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(mockCreateSubscriptionNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateSubscriptionNotification).toHaveBeenCalledWith({
      subscription_id: 42,
      type: "renewal_reminder",
      method: "nostr",
    });
    // A partial success is not a total-delivery failure.
    const errCalls = (console.error as jest.Mock).mock.calls
      .map((args) => String(args[0]))
      .join("\n");
    expect(errCalls).not.toContain("RENEWAL_REMINDER_DELIVERY_FAILED");
  });

  // sendRenewalReminder resolves false (not throws) when the email provider
  // rejects the send — that path must count as "not sent" too.
  it("records no notification row when the email helper resolves false and there is no Nostr identity", async () => {
    mockGetSubscriptionByStripeId.mockResolvedValue(
      makeSubscriptionRow({ buyer_pubkey: null })
    );
    (sendRenewalReminder as jest.Mock).mockResolvedValueOnce(false);
    fireInvoiceUpcoming();

    const res = makeRes();
    await subscriptionWebhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(sendRenewalReminder).toHaveBeenCalledTimes(1);
    expect(mockCreateSubscriptionNotification).not.toHaveBeenCalled();
    const errCalls = (console.error as jest.Mock).mock.calls
      .map((args) => String(args[0]))
      .join("\n");
    expect(errCalls).toContain("RENEWAL_REMINDER_DELIVERY_FAILED");
  });

  it("records only 'nostr' (not 'both') when the email helper resolves false but the DM succeeds", async () => {
    mockGetSubscriptionByStripeId.mockResolvedValue(makeSubscriptionRow());
    (sendRenewalReminder as jest.Mock).mockResolvedValueOnce(false);
    fireInvoiceUpcoming();

    const res = makeRes();
    await subscriptionWebhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(sendServerSideNostrDM).toHaveBeenCalledTimes(1);
    expect(mockCreateSubscriptionNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateSubscriptionNotification).toHaveBeenCalledWith({
      subscription_id: 42,
      type: "renewal_reminder",
      method: "nostr",
    });
  });
});

// A failed recurring payment whose lookup finds no row silently never tells
// the seller — it must be loud instead. A thrown lookup is a transient outage
// and must 500 so Stripe retries.
describe("POST /api/stripe/webhook — invoice.payment_failed orphaned/failed lookup", () => {
  function firePaymentFailed() {
    mockConstructEvent.mockReturnValue({
      id: "evt_pay_failed",
      type: "invoice.payment_failed",
      data: {
        object: {
          id: "in_failed",
          subscription: SUB_ID,
          customer_email: "buyer@example.com",
          amount_due: 1200,
          currency: "usd",
        },
      },
    });
  }

  it("logs a loud greppable marker and still 200s when no subscriptions row matches", async () => {
    mockGetSubscriptionByStripeId.mockResolvedValue(null);
    firePaymentFailed();

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    const errCalls = (console.error as jest.Mock).mock.calls
      .map((args) => String(args[0]))
      .join("\n");
    expect(errCalls).toContain("ORPHANED_SUBSCRIPTION_PAYMENT_FAILED");
    expect(errCalls).toContain(SUB_ID);
    expect(errCalls).toContain("evt_pay_failed");
    // No seller notification may be faked for a row that does not exist.
    expect(sendPaymentFailedToSeller).not.toHaveBeenCalled();
    // Nothing to retry — the row will never appear — so the claim stays.
    expect(mockReleaseStripeEvent).not.toHaveBeenCalled();
  });

  it("500s and releases the event claim when the lookup throws, so Stripe retries", async () => {
    mockGetSubscriptionByStripeId.mockRejectedValue(new Error("db down"));
    firePaymentFailed();

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(500);
    expect(mockReleaseStripeEvent).toHaveBeenCalledWith("evt_pay_failed");
    expect(sendPaymentFailedToSeller).not.toHaveBeenCalled();
    // A transient failure is NOT an orphaned payment failure.
    const errCalls = (console.error as jest.Mock).mock.calls
      .map((args) => String(args[0]))
      .join("\n");
    expect(errCalls).not.toContain("ORPHANED_SUBSCRIPTION_PAYMENT_FAILED");
  });

  it("notifies the seller and logs no marker when the row exists", async () => {
    mockGetSubscriptionByStripeId.mockResolvedValue({
      stripe_subscription_id: SUB_ID,
      seller_pubkey: "b".repeat(64),
    });
    mockGetSellerNotificationEmail.mockResolvedValue("seller@example.com");
    firePaymentFailed();

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(sendPaymentFailedToSeller).toHaveBeenCalledWith(
      "seller@example.com",
      expect.objectContaining({ invoiceId: "in_failed" })
    );
    const errCalls = (console.error as jest.Mock).mock.calls
      .map((args) => String(args[0]))
      .join("\n");
    expect(errCalls).not.toContain("ORPHANED_SUBSCRIPTION_PAYMENT_FAILED");
  });
});

// An agent (MCP) card payment that settles with no matching mcp_orders row
// means money moved but the order is never marked paid — silent unless loud.
describe("POST /api/stripe/webhook — payment_intent.succeeded orphaned MCP order", () => {
  function fireMcpPaymentSucceeded() {
    mockConstructEvent.mockReturnValue({
      id: "evt_mcp_paid",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_mcp_orphan",
          amount: 5000,
          currency: "usd",
          metadata: { source: "mcp", orderId: "order_orphan" },
        },
      },
    });
  }

  beforeEach(() => {
    mockUpdateMcpOrderPayment.mockReset();
    mockAutoPurchaseForMcpOrder.mockClear();
  });

  it("logs a loud greppable marker and still 200s when no mcp_orders row matches", async () => {
    mockUpdateMcpOrderPayment.mockResolvedValue(null);
    fireMcpPaymentSucceeded();

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    const errCalls = (console.error as jest.Mock).mock.calls
      .map((args) => String(args[0]))
      .join("\n");
    expect(errCalls).toContain("ORPHANED_MCP_ORDER_PAYMENT");
    expect(errCalls).toContain("order_orphan");
    expect(errCalls).toContain("pi_mcp_orphan");
    expect(errCalls).toContain("evt_mcp_paid");
    // No label purchase against an order we could not mark paid.
    expect(mockAutoPurchaseForMcpOrder).not.toHaveBeenCalled();
    // Nothing to retry — the row will never appear — so the claim stays.
    expect(mockReleaseStripeEvent).not.toHaveBeenCalled();
  });

  it("500s and releases the event claim when the order update throws, so Stripe retries", async () => {
    mockUpdateMcpOrderPayment.mockRejectedValue(new Error("db down"));
    fireMcpPaymentSucceeded();

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(500);
    expect(mockReleaseStripeEvent).toHaveBeenCalledWith("evt_mcp_paid");
    expect(mockAutoPurchaseForMcpOrder).not.toHaveBeenCalled();
    // A transient failure is NOT an orphaned order payment.
    const errCalls = (console.error as jest.Mock).mock.calls
      .map((args) => String(args[0]))
      .join("\n");
    expect(errCalls).not.toContain("ORPHANED_MCP_ORDER_PAYMENT");
  });

  it("marks the order paid and auto-purchases a label when the row exists", async () => {
    mockUpdateMcpOrderPayment.mockResolvedValue({ order_id: "order_orphan" });
    fireMcpPaymentSucceeded();

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(mockUpdateMcpOrderPayment).toHaveBeenCalledWith(
      "order_orphan",
      "pi_mcp_orphan",
      "paid"
    );
    expect(mockAutoPurchaseForMcpOrder).toHaveBeenCalledWith("order_orphan");
    const errCalls = (console.error as jest.Mock).mock.calls
      .map((args) => String(args[0]))
      .join("\n");
    expect(errCalls).not.toContain("ORPHANED_MCP_ORDER_PAYMENT");
  });
});

// A refund whose affiliate-referral reversal fails transiently (Stripe hiccup
// on the PI retrieve, DB outage) must 500 so Stripe retries — swallowing it
// would silently leave the referral payable and the seller overpaying.
describe("POST /api/stripe/webhook — charge.refunded affiliate reversal failure", () => {
  function fireChargeRefunded() {
    mockConstructEvent.mockReturnValue({
      id: "evt_refund",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_refunded",
          payment_intent: "pi_refunded",
          amount: 5000,
          amount_refunded: 5000,
        },
      },
    });
    mockPaymentIntentsRetrieve.mockResolvedValue({
      id: "pi_refunded",
      metadata: { orderId: "order_1", sellerPubkey: "c".repeat(64) },
    });
  }

  it("500s and releases the event claim when the reversal throws, so Stripe retries", async () => {
    mockReverseReferralsForOrder.mockRejectedValueOnce(new Error("db down"));
    fireChargeRefunded();

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(500);
    expect(mockReleaseStripeEvent).toHaveBeenCalledWith("evt_refund");
  });

  it("reverses the referral and 200s on the happy path", async () => {
    fireChargeRefunded();

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(mockReverseReferralsForOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "order_1",
        sellerPubkey: "c".repeat(64),
        refundEventRef: "evt_refund",
      })
    );
    expect(mockReleaseStripeEvent).not.toHaveBeenCalled();
  });

  it("scopes the PaymentIntent retrieve to event.account for Connect (direct-charge) refunds", async () => {
    // A direct charge lives on the seller's connected account; a
    // platform-scope retrieve would 404 it and (with no catch) retry-loop
    // forever instead of reversing the referral.
    mockConstructEvent.mockReturnValue({
      id: "evt_refund_connect",
      type: "charge.refunded",
      account: CONNECTED_ACCOUNT,
      data: {
        object: {
          id: "ch_refunded_connect",
          payment_intent: "pi_refunded_connect",
          amount: 5000,
          amount_refunded: 5000,
        },
      },
    });
    mockPaymentIntentsRetrieve.mockResolvedValue({
      id: "pi_refunded_connect",
      metadata: { orderId: "order_2", sellerPubkey: "d".repeat(64) },
    });

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(mockPaymentIntentsRetrieve).toHaveBeenCalledWith(
      "pi_refunded_connect",
      { stripeAccount: CONNECTED_ACCOUNT }
    );
    expect(mockReverseReferralsForOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "order_2",
        sellerPubkey: "d".repeat(64),
        refundEventRef: "evt_refund_connect",
      })
    );
    expect(mockReleaseStripeEvent).not.toHaveBeenCalled();
  });
});
