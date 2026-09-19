/** @jest-environment node */

// Route-level coverage for renewal webhooks resolving subscriptions that live
// on the seller's Stripe Connect account. Recurring subscriptions are created
// on the connected account (the subscriptions row stamps connected_account_id),
// so a platform-account stripe.subscriptions.retrieve without { stripeAccount }
// will not find them. Both renewal handlers must pass the recorded account.

const mockConstructEvent = jest.fn();
const mockSubscriptionsRetrieve = jest.fn();
const mockTransfersCreate = jest.fn();
const mockListLineItems = jest.fn(
  async (..._args: any[]): Promise<any> => ({ data: [], has_more: false })
);
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
      list: (...args: any[]) => mockTransfersList(...args),
    },
    invoices: {
      listLineItems: (...args: any[]) => mockListLineItems(...args),
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
const mockSendOrphanedSubscriptionReminderAlert = jest.fn(
  async (..._args: any[]) => true
);
const mockSendOrphanedStripeEventAlert = jest.fn(
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
  sendOrphanedSubscriptionReminderAlert: (...args: any[]) =>
    mockSendOrphanedSubscriptionReminderAlert(...args),
  sendOrphanedStripeEventAlert: (...args: any[]) =>
    mockSendOrphanedStripeEventAlert(...args),
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
const mockTransfersList = jest.fn();
const mockClaimInvoicePayout = jest.fn();
const mockCompleteInvoicePayoutClaim = jest.fn();
const mockReleaseInvoicePayoutClaim = jest.fn();
const mockReleaseStaleInvoicePayoutClaim = jest.fn();

jest.mock("@/utils/stripe/payout-claims", () => ({
  claimInvoicePayout: (...args: any[]) => mockClaimInvoicePayout(...args),
  completeInvoicePayoutClaim: (...args: any[]) =>
    mockCompleteInvoicePayoutClaim(...args),
  releaseInvoicePayoutClaim: (...args: any[]) =>
    mockReleaseInvoicePayoutClaim(...args),
  releaseStaleInvoicePayoutClaim: (...args: any[]) =>
    mockReleaseStaleInvoicePayoutClaim(...args),
  PayoutClaimConflictError: jest.requireActual("@/utils/stripe/payout-claims")
    .PayoutClaimConflictError,
}));

jest.mock("@/utils/stripe/processed-events", () => ({
  claimStripeEvent: (...args: any[]) => mockClaimStripeEvent(...args),
  finalizeStripeEvent: (...args: any[]) => mockFinalizeStripeEvent(...args),
  releaseStripeEvent: (...args: any[]) => mockReleaseStripeEvent(...args),
}));

const mockGetPendingPaymentByIntentId = jest.fn(
  async (..._args: any[]) => null as any
);
const mockGetPendingPayment = jest.fn(async (..._args: any[]) => null as any);
const mockMarkPendingSubscriptionTerminal = jest.fn(
  async (..._args: any[]) => true
);

jest.mock("@/utils/stripe/pending-payments", () => ({
  markPendingPaymentByIntent: jest.fn(async () => undefined),
  getPendingPayment: (...args: any[]) => mockGetPendingPayment(...args),
  getPendingPaymentByIntentId: (...args: any[]) =>
    mockGetPendingPaymentByIntentId(...args),
  markPendingSubscriptionTerminal: (...args: any[]) =>
    mockMarkPendingSubscriptionTerminal(...args),
  // Mirror utils/stripe/pending-payments — the webhook gates legacy
  // referral-key mutation on this server-stamped marker.
  SPLIT_AUTHORITY_METADATA_KEY: "ssSplitAuthority",
  SPLIT_AUTHORITY_PENDING_RECORD: "pending-record-v1",
}));

// Mirrors the mocked utils/stripe/pending-payments constant above (the
// jest.mock factory is hoisted, so test bodies can't import from it).
const SPLIT_AUTHORITY_PENDING_RECORD = "pending-record-v1";

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
    return prev
      .catch(() => {})
      .then(async () => {
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
  mockClaimStripeEvent.mockResolvedValue(1_700_000_000_789);
  mockFinalizeStripeEvent.mockResolvedValue(undefined);
  mockReleaseStripeEvent.mockResolvedValue(undefined);
  // Durable payout claims: default every (invoice, seller) pair to a fresh
  // claim with no history match; tests override per scenario.
  mockClaimInvoicePayout.mockReset();
  mockClaimInvoicePayout.mockResolvedValue({
    created: true,
    transferId: null,
    claimToken: "ctok_1",
  });
  mockCompleteInvoicePayoutClaim.mockResolvedValue(undefined);
  mockReleaseInvoicePayoutClaim.mockResolvedValue(undefined);
  mockReleaseStaleInvoicePayoutClaim.mockResolvedValue(undefined);
  mockTransfersList.mockResolvedValue({ data: [], has_more: false });
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
    const event = {
      id: "evt_renewal",
      type: "invoice.payment_succeeded",
      data: {
        object: {
          id: "in_renewal",
          subscription: SUB_ID,
          billing_reason: "subscription_cycle",
        },
      },
    };
    mockConstructEvent.mockReturnValue(event);
    return event;
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

  it("falls back to event.account for a legacy NULL-account row on a Connect-delivered renewal", async () => {
    mockGetSubscriptionByStripeId.mockResolvedValue({
      stripe_subscription_id: SUB_ID,
      seller_pubkey: "b".repeat(64),
      buyer_pubkey: null,
      buyer_email: "buyer@example.com",
      status: "active",
      connected_account_id: null,
      currency: "usd",
    });
    // Simulate delivery via the Connect endpoint: Stripe stamps the account.
    const event = firePaymentSucceeded();
    (event as any).account = CONNECTED_ACCOUNT;

    const res = makeRes();
    await subscriptionWebhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(mockSubscriptionsRetrieve).toHaveBeenCalledWith(SUB_ID, {
      stripeAccount: CONNECTED_ACCOUNT,
    });
    expect(mockUpdateSubscriptionBillingDate).toHaveBeenCalled();
  });
});

describe("POST /api/stripe/webhook — invoice.paid (handleInvoicePaid)", () => {
  function fireInvoicePaid(lines?: any[]) {
    // The webhook pages stripe.invoices.listLineItems (the embedded
    // invoice.lines is only the first page), so tests drive lines through
    // this mock — a single complete page by default.
    mockListLineItems.mockResolvedValue({
      data: lines ?? [],
      has_more: false,
    });
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
    expect(mockReleaseStripeEvent).toHaveBeenCalledWith(
      "evt_invoice_paid",
      1_700_000_000_789
    );
    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled();
    const errCalls = (console.error as jest.Mock).mock.calls
      .map((args) => String(args[0]))
      .join("\n");
    expect(errCalls).not.toContain("ORPHANED_SUBSCRIPTION_INVOICE_PAID");
    // A transient/happy path is NOT an orphan — no ops email may fire.
    expect(mockSendOrphanedStripeEventAlert).not.toHaveBeenCalled();
  });

  it("aborts before any seller transfer when the Connect-account lookup hits a DB outage", async () => {
    // The transfer loop resolves missing Connect account ids for ALL splits
    // before the first transfers.create, which is not idempotent across a
    // webhook retry — a lookup outage must 500 (claim release → Stripe
    // retry) with zero transfers created, or the retry would double-pay.
    mockGetSubscriptionByStripeId.mockResolvedValue({
      stripe_subscription_id: SUB_ID,
      seller_pubkey: "b".repeat(64),
      connected_account_id: CONNECTED_ACCOUNT,
    });
    mockSubscriptionsRetrieve.mockResolvedValue({
      id: SUB_ID,
      status: "active",
      metadata: {
        isMultiMerchant: "true",
        transferGroup: "tg_outage",
        sellerSplits: JSON.stringify([
          { pubkey: "c".repeat(64), amountCents: 500, accountId: "" },
        ]),
      },
    });
    mockGetStripeConnectAccount.mockRejectedValue(new Error("db down"));
    fireInvoicePaid();

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(500);
    expect(mockTransfersCreate).not.toHaveBeenCalled();
    expect(mockReleaseStripeEvent).toHaveBeenCalledWith(
      "evt_invoice_paid",
      1_700_000_000_789
    );
  });

  it("passes a deterministic per-invoice-per-seller idempotency key so a webhook retry cannot double-pay a seller", async () => {
    const sellerA = "c".repeat(64);
    const sellerB = "d".repeat(64);
    mockGetSubscriptionByStripeId.mockResolvedValue({
      stripe_subscription_id: SUB_ID,
      seller_pubkey: "b".repeat(64),
      connected_account_id: CONNECTED_ACCOUNT,
    });
    mockSubscriptionsRetrieve.mockResolvedValue({
      id: SUB_ID,
      status: "active",
      metadata: {
        isMultiMerchant: "true",
        transferGroup: "tg_retry",
        sellerSplits: JSON.stringify([
          { pubkey: sellerA, amountCents: 500, accountId: "acct_a" },
          { pubkey: sellerB, amountCents: 300, accountId: "acct_b" },
        ]),
      },
    });

    // Emulate Stripe's server-side dedup: a repeated idempotency key returns
    // the original transfer instead of creating a new one.
    const createdByKey = new Map<string, string>();
    let sellerBAttempts = 0;
    mockTransfersCreate.mockImplementation(async (params: any, opts: any) => {
      if (params.destination === "acct_b" && sellerBAttempts++ === 0) {
        throw new Error("stripe 500"); // seller B fails on attempt 1
      }
      const key = opts?.idempotencyKey;
      if (createdByKey.has(key)) {
        return { id: createdByKey.get(key), duplicate: true };
      }
      const id = `tr_${createdByKey.size}`;
      createdByKey.set(key, id);
      return { id };
    });

    fireInvoicePaid();
    const res1 = makeRes();
    await webhookHandler(makeReq(), res1);
    // Seller B's retryable transfer failure must NOT finalize the event:
    // the 500 releases the claim so Stripe retries and can still pay B.
    expect(res1.statusCode).toBe(500);
    expect(mockReleaseStripeEvent).toHaveBeenCalled();
    expect(mockTransfersCreate).toHaveBeenCalledTimes(2);

    // Stripe retries the same event (at-least-once delivery).
    fireInvoicePaid();
    const res2 = makeRes();
    await webhookHandler(makeReq(), res2);
    expect(res2.statusCode).toBe(200);
    expect(mockTransfersCreate).toHaveBeenCalledTimes(4);

    // Each seller's retry carried the SAME deterministic key, so Stripe
    // deduped seller A's second call: exactly one transfer per seller exists.
    const calls = mockTransfersCreate.mock.calls;
    expect(calls[0][1]).toEqual({
      idempotencyKey: `invoice-in_paid-transfer-${sellerA}`,
    });
    expect(calls[2][1]).toEqual({
      idempotencyKey: `invoice-in_paid-transfer-${sellerA}`,
    });
    expect(calls[1][1]).toEqual({
      idempotencyKey: `invoice-in_paid-transfer-${sellerB}`,
    });
    expect(calls[3][1]).toEqual({
      idempotencyKey: `invoice-in_paid-transfer-${sellerB}`,
    });
    expect(createdByKey.size).toBe(2);
  });

  // Shared fixture for record-based multi-seller recurring carts: a weekly
  // item per seller A and B, a monthly item for seller C, and a one-time
  // item for seller B. Allocation mirrors what create-cart-subscription
  // persists in stripe_pending_payments.
  const REC_SELLER_A = "c".repeat(64);
  const REC_SELLER_B = "d".repeat(64);
  const REC_SELLER_C = "e".repeat(64);
  function setupRecordBasedCart() {
    mockGetSubscriptionByStripeId.mockResolvedValue({
      stripe_subscription_id: SUB_ID,
      seller_pubkey: "b".repeat(64),
      connected_account_id: null,
    });
    mockSubscriptionsRetrieve.mockResolvedValue({
      id: SUB_ID,
      status: "active",
      metadata: {
        isMultiMerchant: "true",
        transferGroup: "cart_sub_record",
        // Deliberately NO sellerSplits — this is the post-cap-fix shape.
        ssSplitAuthority: SPLIT_AUTHORITY_PENDING_RECORD,
      },
    });
    mockGetPendingPayment.mockResolvedValue({
      intentRef: "cart_sub_record",
      metadata: {
        transferGroup: "cart_sub_record",
        // Static totals are creation-time context only; with allocations
        // present the webhook must pay from the invoice's actual lines.
        sellerSplits: [
          // donationPercent rides the authority record: payouts are NET of
          // the cut, computed per-invoice from the actual line amounts.
          {
            pubkey: REC_SELLER_A,
            amountCents: 9999,
            accountId: "acct_a",
            donationPercent: 10, // 1125 → 1012
          },
          {
            pubkey: REC_SELLER_B,
            amountCents: 9999,
            accountId: "acct_b",
            donationPercent: 0, // no fee: net === gross
          },
          {
            pubkey: REC_SELLER_C,
            amountCents: 9999,
            accountId: "acct_c",
            donationPercent: 20, // 4000 → 3200
          },
        ],
        priceAllocations: [
          { priceId: "price_weekly_a", sellerPubkey: REC_SELLER_A },
          { priceId: "price_weekly_b", sellerPubkey: REC_SELLER_B },
          { priceId: "price_monthly_c", sellerPubkey: REC_SELLER_C },
          { priceId: "price_onetime_b", sellerPubkey: REC_SELLER_B },
        ],
      },
    });
    mockTransfersCreate.mockResolvedValue({ id: "tr_ok" });
  }

  function transfersBySeller() {
    return new Map(
      mockTransfersCreate.mock.calls.map((c) => [
        c[0].metadata.sellerPubkey,
        c[0].amount,
      ])
    );
  }

  it("resolves splits from the record and pays the INITIAL invoice's actual lines, one-time items included", async () => {
    setupRecordBasedCart();
    fireInvoicePaid([
      { amount: 1125, price: { id: "price_weekly_a" } },
      { amount: 3600, price: { id: "price_weekly_b" } },
      { amount: 4000, price: { id: "price_monthly_c" } },
      { amount: 900, price: { id: "price_onetime_b" } },
    ]);

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(mockGetPendingPayment).toHaveBeenCalledWith("cart_sub_record");
    // Amounts come from the invoice lines (not the static 9999 totals), and
    // seller B gets its weekly + one-time lines combined.
    const bySeller = transfersBySeller();
    // Transfers are NET of each seller's recorded donation/platform-fee
    // cut: A 1125 - 10% = 1012, B 0% = gross, C 4000 - 20% = 3200.
    expect(bySeller.get(REC_SELLER_A)).toBe(1012);
    expect(bySeller.get(REC_SELLER_B)).toBe(4500);
    expect(bySeller.get(REC_SELLER_C)).toBe(3200);
  });

  it("weekly renewal pays only the weekly sellers — never the monthly seller or the one-time item again", async () => {
    setupRecordBasedCart();
    fireInvoicePaid([
      { amount: 1125, price: { id: "price_weekly_a" } },
      { amount: 3600, price: { id: "price_weekly_b" } },
    ]);

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    const bySeller = transfersBySeller();
    expect(bySeller.get(REC_SELLER_A)).toBe(1012); // 1125 net of 10% cut
    expect(bySeller.get(REC_SELLER_B)).toBe(3600); // 0% fee: gross
    expect(bySeller.has(REC_SELLER_C)).toBe(false);
    expect(mockTransfersCreate).toHaveBeenCalledTimes(2);
  });

  it("monthly renewal pays only the monthly seller", async () => {
    setupRecordBasedCart();
    fireInvoicePaid([{ amount: 4000, price: { id: "price_monthly_c" } }]);

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    const bySeller = transfersBySeller();
    expect(bySeller.get(REC_SELLER_C)).toBe(3200); // 4000 net of 20% cut
    expect(mockTransfersCreate).toHaveBeenCalledTimes(1);
  });

  it("500s + releases the claim when ONE seller's transfer fails retryably — Stripe's retry is the only reconciliation", async () => {
    setupRecordBasedCart();
    fireInvoicePaid([
      { amount: 1125, price: { id: "price_weekly_a" } },
      { amount: 3600, price: { id: "price_weekly_b" } },
    ]);
    // Seller B's transfer fails transiently; seller A's succeeds. Finalizing
    // the event would leave B permanently unpaid, so the webhook must throw:
    // the 500 releases the claim, Stripe retries, and A is protected from
    // double-pay by the per-invoice/per-seller idempotency key.
    mockTransfersCreate.mockImplementation(async (params: any) => {
      if (params.metadata.sellerPubkey === REC_SELLER_B) {
        throw new Error("transient stripe error");
      }
      return { id: "tr_ok" };
    });

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(500);
    // Both transfers were still attempted before the throw.
    expect(mockTransfersCreate).toHaveBeenCalledTimes(2);
    expect(mockReleaseStripeEvent).toHaveBeenCalled();
  });

  it("a webhook retry AFTER Stripe's ~24h idempotency window cannot double-pay: the durable invoice+seller claim decides", async () => {
    setupRecordBasedCart();
    fireInvoicePaid([
      { amount: 1125, price: { id: "price_weekly_a" } },
      { amount: 3600, price: { id: "price_weekly_b" } },
    ]);
    // Attempt 1: A pays (claim completed), B's transfer fails (claim
    // released) → 500 → Stripe schedules a retry.
    mockTransfersCreate.mockImplementation(async (params: any) => {
      if (params.metadata.sellerPubkey === REC_SELLER_B) {
        throw new Error("stripe 500");
      }
      return { id: "tr_A_paid" };
    });
    const res1 = makeRes();
    await webhookHandler(makeReq(), res1);
    expect(res1.statusCode).toBe(500);
    expect(mockTransfersCreate).toHaveBeenCalledTimes(2);
    // B's failed attempt released ITS OWN claim with ITS OWN fencing token.
    expect(mockReleaseInvoicePayoutClaim).toHaveBeenCalledWith(
      "in_paid",
      REC_SELLER_B,
      "ctok_1"
    );

    // Attempt 2 — days later: Stripe's idempotency cache has EXPIRED (this
    // create mock would happily mint a brand-new transfer for anyone who
    // asks). The durable claim is the only thing still protecting seller A.
    mockTransfersCreate.mockClear();
    mockTransfersCreate.mockResolvedValue({ id: "tr_B_late" });
    mockClaimInvoicePayout.mockImplementation(
      async (_invoiceId: string, seller: string) =>
        seller === REC_SELLER_B
          ? // B's failed attempt released its claim; this is a fresh one.
            { created: true, transferId: null, claimToken: "ctok_B2" }
          : { created: false, transferId: "tr_A_paid", claimToken: null } // A: durably paid
    );

    fireInvoicePaid([
      { amount: 1125, price: { id: "price_weekly_a" } },
      { amount: 3600, price: { id: "price_weekly_b" } },
    ]);
    const res2 = makeRes();
    await webhookHandler(makeReq(), res2);

    expect(res2.statusCode).toBe(200);
    // ONLY seller B's transfer is created — A is skipped from the claim
    // alone, without any Stripe call.
    expect(mockTransfersCreate).toHaveBeenCalledTimes(1);
    expect(mockTransfersCreate.mock.calls[0][0].metadata.sellerPubkey).toBe(
      REC_SELLER_B
    );
    expect(mockCompleteInvoicePayoutClaim).toHaveBeenCalledWith(
      "in_paid",
      REC_SELLER_B,
      "tr_B_late",
      "ctok_B2"
    );
  });

  it("does NOT finalize while a seller's payout claim is owned by an in-flight attempt", async () => {
    // B's claim exists, is incomplete, and is FRESH (inside the stale
    // window): another attempt owns it. An unresolved claim is not proof of
    // payment — finalizing a 200 here would strand B if the owner crashed.
    // The webhook must fail retryable so Stripe retries until the claim
    // completes or goes stale enough to take over.
    setupRecordBasedCart();
    fireInvoicePaid([
      { amount: 1125, price: { id: "price_weekly_a" } },
      { amount: 3600, price: { id: "price_weekly_b" } },
    ]);
    mockClaimInvoicePayout.mockImplementation(
      async (_invoiceId: string, seller: string) =>
        seller === REC_SELLER_B
          ? { created: false, transferId: null } // live-owned, incomplete
          : { created: true, transferId: null }
    );

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(500);
    expect(mockReleaseStripeEvent).toHaveBeenCalled();
    // A still paid (net of its 10% cut)...
    expect(mockTransfersCreate).toHaveBeenCalledTimes(1);
    expect(mockTransfersCreate.mock.calls[0][0].metadata.sellerPubkey).toBe(
      REC_SELLER_A
    );
    // ...and B's live-owned claim was never released or completed by us.
    expect(mockReleaseInvoicePayoutClaim).not.toHaveBeenCalled();
    expect(mockCompleteInvoicePayoutClaim).not.toHaveBeenCalledWith(
      "in_paid",
      REC_SELLER_B,
      expect.anything()
    );
  });

  it("fences a stale owner out after claim takeover: completion carries the CURRENT attempt's rotated token", async () => {
    // Attempt 1 claimed with token ctok_A, then crashed. Attempt 2 found
    // the claim provably stale, released it, and reclaimed — receiving a
    // ROTATED token ctok_B. Completion must carry ctok_B, so a resumed
    // attempt 1 writing with ctok_A matches zero rows at SQL level and
    // fails loudly instead of recording its transfer on the new owner's
    // claim (the SQL-level proof lives in payout-claims-live.test.ts).
    setupRecordBasedCart();
    fireInvoicePaid([{ amount: 1125, price: { id: "price_weekly_a" } }]);
    mockClaimInvoicePayout
      .mockResolvedValueOnce({
        created: false, // the stale row — not ours, no token handed out
        transferId: null,
        claimToken: null,
      })
      .mockResolvedValueOnce({
        created: true, // reclaimed after the stale release, token rotated
        transferId: null,
        claimToken: "ctok_B",
      });

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(mockReleaseStaleInvoicePayoutClaim).toHaveBeenCalledWith(
      "in_paid",
      REC_SELLER_A,
      600000
    );
    expect(mockCompleteInvoicePayoutClaim).toHaveBeenCalledWith(
      "in_paid",
      REC_SELLER_A,
      "tr_ok",
      "ctok_B"
    );
  });

  it("a 100%-donation seller (a UI-supported setting) is skipped cleanly: no zero-amount transfer, claim resolved with a terminal sentinel", async () => {
    // If the webhook rejected or retried a paid invoice forever because a
    // seller donates everything, checkout would be paid-but-permanently-
    // unpayable. The seller's share is durably resolved instead.
    setupRecordBasedCart();
    mockGetPendingPayment.mockResolvedValue({
      intentRef: "cart_sub_record",
      metadata: {
        transferGroup: "cart_sub_record",
        sellerSplits: [
          {
            pubkey: REC_SELLER_A,
            amountCents: 9999,
            accountId: "acct_a",
            donationPercent: 10,
          },
          {
            pubkey: REC_SELLER_C,
            amountCents: 9999,
            accountId: "acct_c",
            donationPercent: 100,
          },
        ],
        priceAllocations: [
          { priceId: "price_weekly_a", sellerPubkey: REC_SELLER_A },
          { priceId: "price_monthly_c", sellerPubkey: REC_SELLER_C },
        ],
      },
    });
    fireInvoicePaid([
      { amount: 1125, price: { id: "price_weekly_a" } },
      { amount: 4000, price: { id: "price_monthly_c" } },
    ]);

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    // A is paid net of its 10% cut; C gets NO transfer (Stripe rejects
    // 0-amount) — the claim carries a terminal sentinel instead.
    const bySeller = transfersBySeller();
    expect(bySeller.get(REC_SELLER_A)).toBe(1012);
    expect(bySeller.has(REC_SELLER_C)).toBe(false);
    expect(mockTransfersCreate).toHaveBeenCalledTimes(1);
    expect(mockCompleteInvoicePayoutClaim).toHaveBeenCalledWith(
      "in_paid",
      REC_SELLER_C,
      `full-donation:in_paid:${REC_SELLER_C}`,
      "ctok_1"
    );
  });

  it("a renewal whose only seller donates 100% succeeds with zero transfers", async () => {
    setupRecordBasedCart();
    mockGetPendingPayment.mockResolvedValue({
      intentRef: "cart_sub_record",
      metadata: {
        transferGroup: "cart_sub_record",
        sellerSplits: [
          {
            pubkey: REC_SELLER_C,
            amountCents: 9999,
            accountId: "acct_c",
            donationPercent: 100,
          },
        ],
        priceAllocations: [
          { priceId: "price_monthly_c", sellerPubkey: REC_SELLER_C },
        ],
      },
    });
    fireInvoicePaid([{ amount: 4000, price: { id: "price_monthly_c" } }]);

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(mockTransfersCreate).not.toHaveBeenCalled();
    expect(mockCompleteInvoicePayoutClaim).toHaveBeenCalledWith(
      "in_paid",
      REC_SELLER_C,
      `full-donation:in_paid:${REC_SELLER_C}`,
      "ctok_1"
    );
  });

  it("rounding never consumes the whole payout at a partial percent — the seller keeps at least 1 unit", async () => {
    // ceil(3 * 0.99) = 3 = gross: the shared contract clamps the cut to 2
    // so the fee is neither waived nor the seller zeroed.
    setupRecordBasedCart();
    mockGetPendingPayment.mockResolvedValue({
      intentRef: "cart_sub_record",
      metadata: {
        transferGroup: "cart_sub_record",
        sellerSplits: [
          {
            pubkey: REC_SELLER_A,
            amountCents: 9999,
            accountId: "acct_a",
            donationPercent: 99,
          },
        ],
        priceAllocations: [
          { priceId: "price_weekly_a", sellerPubkey: REC_SELLER_A },
        ],
      },
    });
    fireInvoicePaid([{ amount: 3, price: { id: "price_weekly_a" } }]);

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(transfersBySeller().get(REC_SELLER_A)).toBe(1);
  });

  it("fails closed when a record split's donationPercent is missing or malformed", async () => {
    // The payout cut is computed from this percent — guessing 0 would
    // silently waive the platform fee — so a malformed record must 500 and
    // pay nobody, never fall back to gross transfers.
    setupRecordBasedCart();
    fireInvoicePaid([{ amount: 1125, price: { id: "price_weekly_a" } }]);
    mockGetPendingPayment.mockResolvedValue({
      intentRef: "cart_sub_record",
      metadata: {
        transferGroup: "cart_sub_record",
        sellerSplits: [
          // donationPercent deliberately absent
          { pubkey: REC_SELLER_A, amountCents: 9999, accountId: "acct_a" },
        ],
        priceAllocations: [
          { priceId: "price_weekly_a", sellerPubkey: REC_SELLER_A },
        ],
      },
    });

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(500);
    expect(mockTransfersCreate).not.toHaveBeenCalled();
    expect(mockReleaseStripeEvent).toHaveBeenCalled();
  });

  it("paginates listLineItems so sellers beyond the first page are still paid", async () => {
    // The embedded invoice.lines is only the first handful of lines; paying
    // from it alone would silently short sellers on later pages.
    setupRecordBasedCart();
    fireInvoicePaid();
    mockListLineItems.mockImplementation(async (_id: string, params: any) => {
      if (!params?.starting_after) {
        return {
          data: [
            { id: "li_1", amount: 1125, price: { id: "price_weekly_a" } },
            { id: "li_2", amount: 4000, price: { id: "price_monthly_c" } },
          ],
          has_more: true,
        };
      }
      expect(params.starting_after).toBe("li_2");
      return {
        data: [
          { id: "li_3", amount: 3600, price: { id: "price_weekly_b" } },
          { id: "li_4", amount: 900, price: { id: "price_onetime_b" } },
        ],
        has_more: false,
      };
    });

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(mockListLineItems).toHaveBeenCalledTimes(2);
    const bySeller = transfersBySeller();
    // Transfers are NET of each seller's recorded donation/platform-fee
    // cut: A 1125 - 10% = 1012, B 0% = gross, C 4000 - 20% = 3200.
    expect(bySeller.get(REC_SELLER_A)).toBe(1012);
    expect(bySeller.get(REC_SELLER_B)).toBe(4500);
    expect(bySeller.get(REC_SELLER_C)).toBe(3200);
  });

  it("fails closed when a nonzero invoice line maps to no recorded seller price", async () => {
    // An unattributed line must never be guessed at or silently kept on the
    // platform account — that permanently shorts a seller.
    setupRecordBasedCart();
    fireInvoicePaid([
      { amount: 1125, price: { id: "price_weekly_a" } },
      { amount: 700, price: { id: "price_unknown" } },
    ]);

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(500);
    expect(mockTransfersCreate).not.toHaveBeenCalled();
    expect(mockReleaseStripeEvent).toHaveBeenCalledWith(
      "evt_invoice_paid",
      1_700_000_000_789
    );
    const errCalls = (console.error as jest.Mock).mock.calls
      .map((args) => String(args[0]))
      .join("\n");
    expect(errCalls).toContain("UNALLOCATED_INVOICE_LINE");
    expect(mockSendOrphanedStripeEventAlert).toHaveBeenCalledWith(
      expect.objectContaining({ marker: "UNALLOCATED_INVOICE_LINE" })
    );
  });

  it("fails closed when a paid invoice has no line items at all", async () => {
    setupRecordBasedCart();
    fireInvoicePaid([]);

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(500);
    expect(mockTransfersCreate).not.toHaveBeenCalled();
    expect(mockReleaseStripeEvent).toHaveBeenCalledWith(
      "evt_invoice_paid",
      1_700_000_000_789
    );
  });

  it("skips $0 lines without failing (trials and full-credit offsets pay nobody)", async () => {
    setupRecordBasedCart();
    fireInvoicePaid([
      { amount: 1125, price: { id: "price_weekly_a" } },
      { amount: 0, price: { id: "price_unknown_freebie" } },
    ]);

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    const bySeller = transfersBySeller();
    expect(bySeller.get(REC_SELLER_A)).toBe(1012); // net of 10% cut
    expect(mockTransfersCreate).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the authority marker is present but the split record is missing", async () => {
    // A record-era subscription must NEVER fall through to the legacy
    // metadata path — it carries no sellerSplits, so that path would 200
    // with zero payouts.
    mockGetSubscriptionByStripeId.mockResolvedValue({
      stripe_subscription_id: SUB_ID,
      seller_pubkey: "b".repeat(64),
      connected_account_id: null,
    });
    mockSubscriptionsRetrieve.mockResolvedValue({
      id: SUB_ID,
      status: "active",
      metadata: {
        isMultiMerchant: "true",
        transferGroup: "cart_sub_gone",
        ssSplitAuthority: SPLIT_AUTHORITY_PENDING_RECORD,
      },
    });
    mockGetPendingPayment.mockResolvedValue(null);
    fireInvoicePaid([{ amount: 1125, price: { id: "price_weekly_a" } }]);

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(500);
    expect(mockTransfersCreate).not.toHaveBeenCalled();
    expect(mockReleaseStripeEvent).toHaveBeenCalledWith(
      "evt_invoice_paid",
      1_700_000_000_789
    );
    const errCalls = (console.error as jest.Mock).mock.calls
      .map((args) => String(args[0]))
      .join("\n");
    expect(errCalls).toContain("MISSING_SUBSCRIPTION_SPLIT_RECORD");
    expect(mockSendOrphanedStripeEventAlert).toHaveBeenCalledWith(
      expect.objectContaining({ marker: "MISSING_SUBSCRIPTION_SPLIT_RECORD" })
    );
  });

  it("fails closed when line-item pagination never settles has_more to false", async () => {
    // A partial line set must never reach the transfer loop — it would pay
    // only the visible sellers and finalize the claim.
    setupRecordBasedCart();
    fireInvoicePaid();
    mockListLineItems.mockResolvedValue({
      data: [],
      has_more: true, // claims more pages but returns nothing to page with
    });

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(500);
    expect(mockTransfersCreate).not.toHaveBeenCalled();
    expect(mockReleaseStripeEvent).toHaveBeenCalledWith(
      "evt_invoice_paid",
      1_700_000_000_789
    );
    const errCalls = (console.error as jest.Mock).mock.calls
      .map((args) => String(args[0]))
      .join("\n");
    expect(errCalls).toContain("INCOMPLETE_INVOICE_LINES");
  });

  it("500s and releases the claim when the pending split-record lookup hits a DB outage, so Stripe retries", async () => {
    // The record is the payout source of truth for new multi-seller
    // recurring carts; swallowing a lookup outage as null would fall through
    // to a legacy metadata path that doesn't exist for them and skip every
    // seller payout. Propagate instead (500 + claim release → Stripe retry).
    mockGetSubscriptionByStripeId.mockResolvedValue({
      stripe_subscription_id: SUB_ID,
      seller_pubkey: "b".repeat(64),
      connected_account_id: null,
    });
    mockSubscriptionsRetrieve.mockResolvedValue({
      id: SUB_ID,
      status: "active",
      metadata: { isMultiMerchant: "true", transferGroup: "cart_sub_db" },
    });
    mockGetPendingPayment.mockRejectedValue(new Error("db down"));
    fireInvoicePaid();

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(500);
    expect(mockTransfersCreate).not.toHaveBeenCalled();
    expect(mockReleaseStripeEvent).toHaveBeenCalledWith(
      "evt_invoice_paid",
      1_700_000_000_789
    );
  });

  it("fails closed on the WHOLE record when any split entry is malformed — no partial payout, claim released, ops alerted", async () => {
    // A malformed entry in the authoritative record means the record can't be
    // trusted to name every seller/amount; paying the well-formed remainder
    // would permanently short the malformed seller. 500 + claim release +
    // ops alert, zero transfers.
    const sellerA = "c".repeat(64);
    mockGetSubscriptionByStripeId.mockResolvedValue({
      stripe_subscription_id: SUB_ID,
      seller_pubkey: "b".repeat(64),
      connected_account_id: null,
    });
    mockSubscriptionsRetrieve.mockResolvedValue({
      id: SUB_ID,
      status: "active",
      metadata: { isMultiMerchant: "true", transferGroup: "cart_sub_mixed" },
    });
    mockGetPendingPayment.mockResolvedValue({
      intentRef: "cart_sub_mixed",
      metadata: {
        sellerSplits: [
          { pubkey: sellerA, amountCents: 500, accountId: "acct_a" },
          { pubkey: "", amountCents: 300, accountId: "acct_b" },
          null,
        ],
      },
    });
    mockTransfersCreate.mockResolvedValue({ id: "tr_ok" });
    fireInvoicePaid();

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(500);
    expect(mockTransfersCreate).not.toHaveBeenCalled();
    expect(mockReleaseStripeEvent).toHaveBeenCalledWith(
      "evt_invoice_paid",
      1_700_000_000_789
    );
    const errCalls = (console.error as jest.Mock).mock.calls
      .map((args) => String(args[0]))
      .join("\n");
    expect(errCalls).toContain("MALFORMED_SUBSCRIPTION_SPLIT_RECORD");
    expect(mockSendOrphanedStripeEventAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        marker: "MALFORMED_SUBSCRIPTION_SPLIT_RECORD",
      })
    );
  });

  it("fails closed when a price allocation entry is malformed", async () => {
    const sellerA = "c".repeat(64);
    mockGetSubscriptionByStripeId.mockResolvedValue({
      stripe_subscription_id: SUB_ID,
      seller_pubkey: "b".repeat(64),
      connected_account_id: null,
    });
    mockSubscriptionsRetrieve.mockResolvedValue({
      id: SUB_ID,
      status: "active",
      metadata: { isMultiMerchant: "true", transferGroup: "cart_sub_badalloc" },
    });
    mockGetPendingPayment.mockResolvedValue({
      intentRef: "cart_sub_badalloc",
      metadata: {
        sellerSplits: [
          { pubkey: sellerA, amountCents: 500, accountId: "acct_a" },
        ],
        priceAllocations: [{ priceId: "", sellerPubkey: sellerA }],
      },
    });
    fireInvoicePaid([{ amount: 500, price: { id: "price_a" } }]);

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(500);
    expect(mockTransfersCreate).not.toHaveBeenCalled();
    expect(mockReleaseStripeEvent).toHaveBeenCalledWith(
      "evt_invoice_paid",
      1_700_000_000_789
    );
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
    // The marker is paired with a direct ops email so a human reconciles
    // promptly instead of discovering a missing payout from a complaint.
    expect(mockSendOrphanedStripeEventAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        marker: "ORPHANED_SUBSCRIPTION_INVOICE_PAID",
      })
    );
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
    expect(mockReleaseStripeEvent).toHaveBeenCalledWith(
      "evt_invoice_paid",
      1_700_000_000_789
    );
    const errCalls = (console.error as jest.Mock).mock.calls
      .map((args) => String(args[0]))
      .join("\n");
    expect(errCalls).not.toContain("ORPHANED_SUBSCRIPTION_INVOICE_PAID");
    // A transient/happy path is NOT an orphan — no ops email may fire.
    expect(mockSendOrphanedStripeEventAlert).not.toHaveBeenCalled();
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
    // A transient/happy path is NOT an orphan — no ops email may fire.
    expect(mockSendOrphanedStripeEventAlert).not.toHaveBeenCalled();
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
    // A transient/happy path is NOT an orphan — no ops email may fire.
    expect(mockSendOrphanedStripeEventAlert).not.toHaveBeenCalled();
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
    expect(mockSendOrphanedStripeEventAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        marker: "ORPHANED_SUBSCRIPTION_INVOICE_PAID",
      })
    );
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
      i < 100 &&
      mockSendOrphanedSubscriptionPaymentAlert.mock.calls.length === 0;
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
    expect(mockReleaseStripeEvent).toHaveBeenCalledWith(
      "evt_orphan",
      1_700_000_000_789
    );
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
    expect(mockReleaseStripeEvent).toHaveBeenCalledWith(
      "evt_orphan_cancel",
      1_700_000_000_789
    );
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

// A cancelled-for-good multi-seller subscription's split record must be
// marked terminal so the pending-payments sweep can prune it (#434) — and a
// failure to mark must never fail the webhook.
describe("POST /api/stripe/subscription-webhook — cancelled multi-merchant split record", () => {
  function fireMultiMerchantDeleted() {
    mockConstructEvent.mockReturnValue({
      id: "evt_mm_cancel",
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: SUB_ID,
          customer: "cus_mm",
          status: "canceled",
          current_period_end: 1700000000,
          metadata: {
            isMultiMerchant: "true",
            transferGroup: "cart_sub_terminal",
          },
        },
      },
    });
  }

  it("marks the subscription's split record terminal on deletion", async () => {
    mockGetSubscriptionByStripeId.mockResolvedValue(null);
    fireMultiMerchantDeleted();

    const res = makeRes();
    await subscriptionWebhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(mockMarkPendingSubscriptionTerminal).toHaveBeenCalledWith(
      "cart_sub_terminal"
    );
  });

  it("still 200s when the terminal mark itself throws", async () => {
    mockGetSubscriptionByStripeId.mockResolvedValue(null);
    mockMarkPendingSubscriptionTerminal.mockRejectedValueOnce(
      new Error("db down")
    );
    fireMultiMerchantDeleted();

    const res = makeRes();
    await subscriptionWebhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(mockReleaseStripeEvent).not.toHaveBeenCalled();
  });

  it("does not mark anything for a single-seller subscription deletion", async () => {
    mockGetSubscriptionByStripeId.mockResolvedValue(null);
    mockConstructEvent.mockReturnValue({
      id: "evt_single_cancel",
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: SUB_ID,
          customer: "cus_single",
          status: "canceled",
          current_period_end: 1700000000,
        },
      },
    });

    const res = makeRes();
    await subscriptionWebhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(mockMarkPendingSubscriptionTerminal).not.toHaveBeenCalled();
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

  it("emails ops when no subscriptions row matches an upcoming invoice, still 200ing", async () => {
    mockGetSubscriptionByStripeId.mockResolvedValue(null);
    fireInvoiceUpcoming();

    const res = makeRes();
    await subscriptionWebhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(mockSendOrphanedSubscriptionReminderAlert).toHaveBeenCalledTimes(1);
    expect(mockSendOrphanedSubscriptionReminderAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeSubscriptionId: SUB_ID,
        invoiceId: "in_upcoming",
        eventId: "evt_orphan_reminder",
        customerEmail: "buyer@example.com",
      })
    );
    // A log line alone is only seen if someone goes looking — but the email
    // must not replace the greppable marker either.
    const errCalls = (console.error as jest.Mock).mock.calls
      .map((args) => String(args[0]))
      .join("\n");
    expect(errCalls).toContain("ORPHANED_SUBSCRIPTION_REMINDER");
  });

  it("still 200s when the orphaned-reminder ops alert itself throws", async () => {
    mockGetSubscriptionByStripeId.mockResolvedValue(null);
    mockSendOrphanedSubscriptionReminderAlert.mockRejectedValueOnce(
      new Error("sendgrid down")
    );
    fireInvoiceUpcoming();

    const res = makeRes();
    await subscriptionWebhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    // The row will never appear on retry, so the claim stays regardless.
    expect(mockReleaseStripeEvent).not.toHaveBeenCalled();
  });

  it("500s and releases the event claim when the lookup throws, so Stripe retries", async () => {
    mockGetSubscriptionByStripeId.mockRejectedValue(new Error("db down"));
    fireInvoiceUpcoming();

    const res = makeRes();
    await subscriptionWebhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(500);
    expect(mockReleaseStripeEvent).toHaveBeenCalledWith(
      "evt_orphan_reminder",
      1_700_000_000_789
    );
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
    // The marker is paired with a direct ops email so a human reconciles.
    expect(mockSendOrphanedStripeEventAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        marker: "ORPHANED_SUBSCRIPTION_PAYMENT_FAILED",
      })
    );
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
    expect(mockReleaseStripeEvent).toHaveBeenCalledWith(
      "evt_pay_failed",
      1_700_000_000_789
    );
    expect(sendPaymentFailedToSeller).not.toHaveBeenCalled();
    // A transient failure is NOT an orphaned payment failure.
    const errCalls = (console.error as jest.Mock).mock.calls
      .map((args) => String(args[0]))
      .join("\n");
    expect(errCalls).not.toContain("ORPHANED_SUBSCRIPTION_PAYMENT_FAILED");
    // A transient/happy path is NOT an orphan — no ops email may fire.
    expect(mockSendOrphanedStripeEventAlert).not.toHaveBeenCalled();
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
    // A transient/happy path is NOT an orphan — no ops email may fire.
    expect(mockSendOrphanedStripeEventAlert).not.toHaveBeenCalled();
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
    // The marker is paired with a direct ops email so a human reconciles.
    expect(mockSendOrphanedStripeEventAlert).toHaveBeenCalledWith(
      expect.objectContaining({ marker: "ORPHANED_MCP_ORDER_PAYMENT" })
    );
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
    expect(mockReleaseStripeEvent).toHaveBeenCalledWith(
      "evt_mcp_paid",
      1_700_000_000_789
    );
    expect(mockAutoPurchaseForMcpOrder).not.toHaveBeenCalled();
    // A transient failure is NOT an orphaned order payment.
    const errCalls = (console.error as jest.Mock).mock.calls
      .map((args) => String(args[0]))
      .join("\n");
    expect(errCalls).not.toContain("ORPHANED_MCP_ORDER_PAYMENT");
    // A transient/happy path is NOT an orphan — no ops email may fire.
    expect(mockSendOrphanedStripeEventAlert).not.toHaveBeenCalled();
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
    // A transient/happy path is NOT an orphan — no ops email may fire.
    expect(mockSendOrphanedStripeEventAlert).not.toHaveBeenCalled();
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
      // Pre-cutover: legacy order-keyed referral rows genuinely exist.
      created: 1700000000,
      metadata: { orderId: "order_1", sellerPubkey: "c".repeat(64) },
    });
  }

  it("500s and releases the event claim when the reversal throws, so Stripe retries", async () => {
    mockReverseReferralsForOrder.mockRejectedValueOnce(new Error("db down"));
    fireChargeRefunded();

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(500);
    expect(mockReleaseStripeEvent).toHaveBeenCalledWith(
      "evt_refund",
      1_700_000_000_789
    );
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
    // The canonical PI-id key is reversed too — recordless legacy intents
    // paid by the current process-transfers accrue under it.
    expect(mockReverseReferralsForOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "pi_refunded",
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
      created: 1700000000,
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

  it("reverses multi-seller refunds against the authoritative split record, ignoring forged metadata", async () => {
    // The PI metadata here is attacker-controlled: a forged orderId and a
    // sellerPubkey naming an unrelated account. The pending-payment record
    // persisted at creation names the real sellers — reversal must target
    // them, keyed by the PaymentIntent id (the referral dedup key written by
    // process-transfers), never the forged metadata.
    mockConstructEvent.mockReturnValue({
      id: "evt_refund_multi",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_refunded_multi",
          payment_intent: "pi_multi",
          amount: 1200,
          amount_refunded: 1200,
        },
      },
    });
    mockPaymentIntentsRetrieve.mockResolvedValue({
      id: "pi_multi",
      // Marked = created by current code, so its referrals can only be
      // PI-keyed: the forged metadata orderId must never drive DB mutation.
      metadata: {
        orderId: "order_evil",
        sellerPubkey: "e".repeat(64),
        ssSplitAuthority: "pending-record-v1",
      },
    });
    mockGetPendingPaymentByIntentId.mockResolvedValue({
      paymentIntentId: "pi_multi",
      metadata: {
        sellerSplits: [
          { pubkey: "c".repeat(64), amountCents: 500 },
          { pubkey: "d".repeat(64), amountCents: 700 },
        ],
      },
    });

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    const reversalCalls = mockReverseReferralsForOrder.mock.calls.filter(
      (c) => (c[0] as any).refundEventRef === "evt_refund_multi"
    );
    // Current intent: ONLY the canonical PI-id key, for the two
    // authoritative sellers.
    expect(reversalCalls).toHaveLength(2);
    expect(mockReverseReferralsForOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "pi_multi",
        sellerPubkey: "c".repeat(64),
        refundEventRef: "evt_refund_multi",
      })
    );
    expect(mockReverseReferralsForOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "pi_multi",
        sellerPubkey: "d".repeat(64),
        refundEventRef: "evt_refund_multi",
      })
    );
    // The forged order key never drives DB mutation on a current intent.
    expect(mockReverseReferralsForOrder).not.toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "order_evil" })
    );
    // The forged sellerPubkey is never consulted.
    expect(mockReverseReferralsForOrder).not.toHaveBeenCalledWith(
      expect.objectContaining({ sellerPubkey: "e".repeat(64) })
    );
  });

  it("reverses under both keys for a pre-cutover intent with an authoritative record", async () => {
    // Pre-cutover multi-seller intent: order-keyed referral rows genuinely
    // exist, so reversal covers BOTH keys — but only for the record's
    // authoritative sellers, never the metadata sellerPubkey.
    mockConstructEvent.mockReturnValue({
      id: "evt_refund_legacy_multi",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_refunded_legacy_multi",
          payment_intent: "pi_legacy_multi",
          amount: 1200,
          amount_refunded: 1200,
        },
      },
    });
    mockPaymentIntentsRetrieve.mockResolvedValue({
      id: "pi_legacy_multi",
      created: 1700000000,
      metadata: { orderId: "order_legacy", sellerPubkey: "e".repeat(64) },
    });
    mockGetPendingPaymentByIntentId.mockResolvedValue({
      paymentIntentId: "pi_legacy_multi",
      metadata: {
        sellerSplits: [
          { pubkey: "c".repeat(64), amountCents: 500 },
          { pubkey: "d".repeat(64), amountCents: 700 },
        ],
      },
    });

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    const calls = mockReverseReferralsForOrder.mock.calls.filter(
      (c) => (c[0] as any).refundEventRef === "evt_refund_legacy_multi"
    );
    // 2 authoritative sellers × 2 keys (canonical PI id + legacy order id).
    expect(calls).toHaveLength(4);
    expect(mockReverseReferralsForOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "order_legacy",
        sellerPubkey: "c".repeat(64),
        refundEventRef: "evt_refund_legacy_multi",
      })
    );
    expect(mockReverseReferralsForOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "pi_legacy_multi",
        sellerPubkey: "d".repeat(64),
        refundEventRef: "evt_refund_legacy_multi",
      })
    );
    expect(mockReverseReferralsForOrder).not.toHaveBeenCalledWith(
      expect.objectContaining({ sellerPubkey: "e".repeat(64) })
    );
  });
});
