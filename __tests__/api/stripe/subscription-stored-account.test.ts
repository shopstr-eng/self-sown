/** @jest-environment node */

// Route-level coverage for the stored connected_account_id on subscription
// rows (Task: reconnecting a different Stripe account must not orphan an
// existing recurring subscription). cancel-subscription and
// update-subscription must target the Connect account recorded on the
// subscription row at creation time, falling back to the caller-supplied
// connectedAccountId only for legacy rows that predate the column.

const mockSubscriptionsUpdate = jest.fn();
const mockSubscriptionsRetrieve = jest.fn();

jest.mock("stripe", () => {
  const Stripe = jest.fn().mockImplementation(() => ({
    subscriptions: {
      update: (...args: any[]) => mockSubscriptionsUpdate(...args),
      retrieve: (...args: any[]) => mockSubscriptionsRetrieve(...args),
    },
  }));
  return { __esModule: true, default: Stripe };
});

const mockGetSubscriptionByStripeId = jest.fn();
const mockUpdateSubscriptionStatus = jest.fn();
const mockUpdateSubscriptionShippingAddress = jest.fn();
const mockUpdateSubscriptionBillingDate = jest.fn();

jest.mock("@/utils/db/db-service", () => ({
  getSubscriptionByStripeId: (...args: any[]) =>
    mockGetSubscriptionByStripeId(...args),
  updateSubscriptionStatus: (...args: any[]) =>
    mockUpdateSubscriptionStatus(...args),
  updateSubscriptionShippingAddress: (...args: any[]) =>
    mockUpdateSubscriptionShippingAddress(...args),
  updateSubscriptionBillingDate: (...args: any[]) =>
    mockUpdateSubscriptionBillingDate(...args),
}));

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn(async () => true),
}));

const SELLER_PUBKEY = "b".repeat(64);

jest.mock("@/utils/nostr/request-auth", () => ({
  buildCancelSubscriptionProof: jest.fn(() => ({})),
  buildUpdateSubscriptionProof: jest.fn(() => ({})),
  extractSignedEventFromRequest: jest.fn(() => ({ pubkey: SELLER_PUBKEY })),
  verifySignedHttpRequestProof: jest.fn(() => ({ ok: true })),
}));

import cancelHandler from "@/pages/api/stripe/cancel-subscription";
import updateHandler from "@/pages/api/stripe/update-subscription";

const SUB_ID = "sub_123";
const STORED_ACCOUNT = "acct_original";
const BODY_ACCOUNT = "acct_reconnected_different";

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

async function callHandler(handler: any, body: Record<string, unknown>) {
  const res = makeRes();
  await handler(makeReq(body), res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSubscriptionsUpdate.mockResolvedValue({
    id: SUB_ID,
    status: "active",
    cancel_at_period_end: true,
    current_period_end: 1700000000,
  });
  mockSubscriptionsRetrieve.mockResolvedValue({
    id: SUB_ID,
    status: "active",
    current_period_end: 1700000000,
  });
});

describe("POST /api/stripe/cancel-subscription — stored connected account", () => {
  it("targets the account recorded on the subscription, not the caller-supplied one", async () => {
    mockGetSubscriptionByStripeId.mockResolvedValue({
      stripe_subscription_id: SUB_ID,
      seller_pubkey: SELLER_PUBKEY,
      buyer_pubkey: null,
      connected_account_id: STORED_ACCOUNT,
    });

    const res = await callHandler(cancelHandler, {
      subscriptionId: SUB_ID,
      connectedAccountId: BODY_ACCOUNT,
    });

    expect(res.statusCode).toBe(200);
    expect(mockSubscriptionsUpdate).toHaveBeenCalledWith(
      SUB_ID,
      { cancel_at_period_end: true },
      { stripeAccount: STORED_ACCOUNT }
    );
    expect(mockUpdateSubscriptionStatus).toHaveBeenCalledWith(
      SUB_ID,
      "canceled"
    );
  });

  it("falls back to the caller-supplied account for legacy rows", async () => {
    mockGetSubscriptionByStripeId.mockResolvedValue({
      stripe_subscription_id: SUB_ID,
      seller_pubkey: SELLER_PUBKEY,
      buyer_pubkey: null,
      connected_account_id: null,
    });

    const res = await callHandler(cancelHandler, {
      subscriptionId: SUB_ID,
      connectedAccountId: BODY_ACCOUNT,
    });

    expect(res.statusCode).toBe(200);
    expect(mockSubscriptionsUpdate).toHaveBeenCalledWith(
      SUB_ID,
      { cancel_at_period_end: true },
      { stripeAccount: BODY_ACCOUNT }
    );
  });

  it("uses no stripeAccount option when neither source has an account", async () => {
    mockGetSubscriptionByStripeId.mockResolvedValue({
      stripe_subscription_id: SUB_ID,
      seller_pubkey: SELLER_PUBKEY,
      buyer_pubkey: null,
      connected_account_id: null,
    });

    const res = await callHandler(cancelHandler, { subscriptionId: SUB_ID });

    expect(res.statusCode).toBe(200);
    expect(mockSubscriptionsUpdate).toHaveBeenCalledWith(
      SUB_ID,
      { cancel_at_period_end: true },
      undefined
    );
  });
});

describe("POST /api/stripe/update-subscription — stored connected account", () => {
  it("targets the account recorded on the subscription, not the caller-supplied one", async () => {
    mockGetSubscriptionByStripeId.mockResolvedValue({
      stripe_subscription_id: SUB_ID,
      seller_pubkey: SELLER_PUBKEY,
      buyer_pubkey: null,
      connected_account_id: STORED_ACCOUNT,
    });

    const res = await callHandler(updateHandler, {
      subscriptionId: SUB_ID,
      connectedAccountId: BODY_ACCOUNT,
      nextBillingDate: "2026-10-01T00:00:00Z",
    });

    expect(res.statusCode).toBe(200);
    expect(mockSubscriptionsUpdate).toHaveBeenCalledWith(
      SUB_ID,
      expect.objectContaining({ proration_behavior: "none" }),
      { stripeAccount: STORED_ACCOUNT }
    );
    expect(mockSubscriptionsRetrieve).toHaveBeenCalledWith(SUB_ID, {
      stripeAccount: STORED_ACCOUNT,
    });
  });

  it("falls back to the caller-supplied account for legacy rows", async () => {
    mockGetSubscriptionByStripeId.mockResolvedValue({
      stripe_subscription_id: SUB_ID,
      seller_pubkey: SELLER_PUBKEY,
      buyer_pubkey: null,
      connected_account_id: null,
    });

    const res = await callHandler(updateHandler, {
      subscriptionId: SUB_ID,
      connectedAccountId: BODY_ACCOUNT,
    });

    expect(res.statusCode).toBe(200);
    expect(mockSubscriptionsRetrieve).toHaveBeenCalledWith(SUB_ID, {
      stripeAccount: BODY_ACCOUNT,
    });
  });
});
