/** @jest-environment node */

// End-to-end wiring proof for the card (Stripe) lifetime checkout. The sibling
// `stripe-webhook-lifetime.test.ts` mocks `applyStripeLifetimePayment` whole, so
// it only proves the route reaches that function — a bad arg mapping INSIDE the
// membership layer (wrong pubkey, wrong billing method, dropped customer id, or
// the lifetime branch silently never firing) would slip through. Here we run the
// REAL membership module and mock only the DB layer, so we can assert the route
// drives a genuine one-time lifetime PaymentIntent all the way down to
// `grantLifetimeMembership({ pubkey, billingMethod: 'stripe', customerId })` —
// and that a recurring subscription event never takes the lifetime branch.

const applyRateLimitMock = jest.fn();
const claimStripeEventMock = jest.fn();
const finalizeStripeEventMock = jest.fn();
const releaseStripeEventMock = jest.fn();
const constructEventMock = jest.fn();
const cancelSubscriptionMock = jest.fn();

// DB layer — the bottom of the stack we assert against.
const grantLifetimeMembershipMock = jest.fn();
const getProMembershipMock = jest.fn();
const getProMembershipBySubscriptionMock = jest.fn();
const applyProStripeStateMock = jest.fn();
const syncProStripeMetaMock = jest.fn();
const getProSettingMock = jest.fn();
const setProSettingMock = jest.fn();

// Best-effort receipt side effects — stubbed so they never touch the network.
const getSellerNotificationEmailMock = jest.fn();
const sendProReceiptMock = jest.fn();
const sendServerSideNostrDMMock = jest.fn();

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: (...args: unknown[]) => applyRateLimitMock(...args),
}));

jest.mock("@/utils/stripe/processed-events", () => ({
  claimStripeEvent: (...args: unknown[]) => claimStripeEventMock(...args),
  finalizeStripeEvent: (...args: unknown[]) => finalizeStripeEventMock(...args),
  releaseStripeEvent: (...args: unknown[]) => releaseStripeEventMock(...args),
}));

// Keep the real stripe-pro (mapStripeSubscription, isProMembershipSubscription,
// WRANGLER constants) so pubkey/term resolution is genuinely exercised; only the
// live Stripe client is replaced.
jest.mock("@/utils/pro/stripe-pro", () => {
  const actual = jest.requireActual("@/utils/pro/stripe-pro");
  return {
    ...actual,
    getProStripe: () => ({
      webhooks: {
        constructEvent: (...args: unknown[]) => constructEventMock(...args),
      },
      subscriptions: {
        cancel: (...args: unknown[]) => cancelSubscriptionMock(...args),
      },
    }),
  };
});

jest.mock("@/utils/stripe/retry-service", () => ({
  withStripeRetry: (fn: () => unknown) => fn(),
  stableIdempotencyKey: jest.fn(),
}));

// The REAL membership module is used (no mock) — this is the whole point.
jest.mock("@/utils/db/pro-membership", () => ({
  grantLifetimeMembership: (...args: unknown[]) =>
    grantLifetimeMembershipMock(...args),
  getProMembership: (...args: unknown[]) => getProMembershipMock(...args),
  getProMembershipBySubscription: (...args: unknown[]) =>
    getProMembershipBySubscriptionMock(...args),
  applyProStripeState: (...args: unknown[]) => applyProStripeStateMock(...args),
  syncProStripeMeta: (...args: unknown[]) => syncProStripeMetaMock(...args),
  getProSetting: (...args: unknown[]) => getProSettingMock(...args),
  setProSetting: (...args: unknown[]) => setProSettingMock(...args),
  // Imports membership.ts pulls in at module load but these tests don't drive.
  grantProTrialIfMissing: jest.fn(),
  listExistingStallPubkeys: jest.fn(),
  listPaidProManualInvoices: jest.fn(),
  listSettledManualInvoicesMissingCoverage: jest.fn(),
  setProManualInvoiceCoverage: jest.fn(),
}));

jest.mock("@/utils/db/db-service", () => ({
  getSellerNotificationEmail: (...args: unknown[]) =>
    getSellerNotificationEmailMock(...args),
}));

jest.mock("@/utils/email/email-service", () => ({
  sendProReceipt: (...args: unknown[]) => sendProReceiptMock(...args),
  sendProLifetimeLingeringCancelAlert: jest.fn(),
}));

jest.mock("@/utils/nostr/server-nostr-helpers", () => ({
  sendServerSideNostrDM: (...args: unknown[]) =>
    sendServerSideNostrDMMock(...args),
}));

import handler from "@/pages/api/pro/stripe-webhook";

function createRequest() {
  return {
    method: "POST",
    headers: { "stripe-signature": "test-sig" },
    on(event: string, cb: (arg?: unknown) => void) {
      if (event === "end") cb();
      return this;
    },
  } as any;
}

function createResponse() {
  return {
    statusCode: 200,
    jsonBody: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.jsonBody = payload;
      return this;
    },
  };
}

const FUTURE_UNIX = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;

describe("/api/pro/stripe-webhook — card lifetime checkout drives grantLifetimeMembership", () => {
  const originalSecret = process.env.STRIPE_PRO_WEBHOOK_SECRET;

  beforeEach(() => {
    applyRateLimitMock.mockReset().mockReturnValue(true);
    claimStripeEventMock.mockReset().mockResolvedValue(true);
    finalizeStripeEventMock.mockReset().mockResolvedValue(undefined);
    releaseStripeEventMock.mockReset().mockResolvedValue(undefined);
    constructEventMock.mockReset();
    cancelSubscriptionMock.mockReset().mockResolvedValue({});

    grantLifetimeMembershipMock.mockReset().mockResolvedValue(undefined);
    getProMembershipMock.mockReset().mockResolvedValue(null);
    getProMembershipBySubscriptionMock.mockReset().mockResolvedValue(null);
    applyProStripeStateMock.mockReset().mockResolvedValue(undefined);
    syncProStripeMetaMock.mockReset().mockResolvedValue(undefined);
    getProSettingMock.mockReset().mockResolvedValue(null);
    setProSettingMock.mockReset().mockResolvedValue(undefined);

    getSellerNotificationEmailMock.mockReset().mockResolvedValue(null);
    sendProReceiptMock.mockReset().mockResolvedValue(undefined);
    sendServerSideNostrDMMock.mockReset().mockResolvedValue(undefined);

    process.env.STRIPE_PRO_WEBHOOK_SECRET = "whsec_test";
  });

  afterAll(() => {
    process.env.STRIPE_PRO_WEBHOOK_SECRET = originalSecret;
  });

  it("grants a never-expiring lifetime membership with the resolved pubkey, 'stripe' billing method, and customer id", async () => {
    // Seller had no prior recurring subscription, so the at-purchase cancel is a
    // no-op and the route flows straight into the lifetime grant.
    getProMembershipMock.mockResolvedValue({ stripe_subscription_id: null });

    constructEventMock.mockReturnValue({
      id: "evt_lifetime",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_lifetime",
          customer: "cus_wrangler",
          amount_received: 210000,
          currency: "usd",
          created: 1_700_000_000,
          metadata: { proLifetime: "true", mmProPubkey: "seller-pubkey" },
        },
      },
    });

    const res = createResponse();
    await handler(createRequest(), res as any);

    expect(res.statusCode).toBe(200);
    expect(grantLifetimeMembershipMock).toHaveBeenCalledTimes(1);
    expect(grantLifetimeMembershipMock).toHaveBeenCalledWith({
      pubkey: "seller-pubkey",
      billingMethod: "stripe",
      customerId: "cus_wrangler",
    });
    // Lifetime is a one-time payment — it must NOT run any subscription-state
    // mapping (that's the recurring rail).
    expect(applyProStripeStateMock).not.toHaveBeenCalled();
  });

  it("passes a null customer id through when the lifetime PaymentIntent has no customer attached", async () => {
    getProMembershipMock.mockResolvedValue({ stripe_subscription_id: null });

    constructEventMock.mockReturnValue({
      id: "evt_lifetime_no_cust",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_lifetime",
          customer: null,
          amount_received: 210000,
          currency: "usd",
          metadata: { proLifetime: "true", mmProPubkey: "seller-pubkey" },
        },
      },
    });

    const res = createResponse();
    await handler(createRequest(), res as any);

    expect(res.statusCode).toBe(200);
    expect(grantLifetimeMembershipMock).toHaveBeenCalledWith({
      pubkey: "seller-pubkey",
      billingMethod: "stripe",
      customerId: null,
    });
  });

  it("does NOT take the lifetime branch for a recurring Pro subscription event", async () => {
    // A normal active monthly subscriber renewing — the route must route this to
    // the subscription mapper, never to grantLifetimeMembership.
    getProMembershipMock.mockResolvedValue({ lifetime: false });

    constructEventMock.mockReturnValue({
      id: "evt_sub",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_recurring",
          status: "active",
          customer: "cus_recurring",
          cancel_at_period_end: false,
          current_period_end: FUTURE_UNIX,
          metadata: { mmProPubkey: "seller-pubkey", proMembership: "true" },
          items: {
            data: [
              {
                price: { recurring: { interval: "month" } },
                current_period_end: FUTURE_UNIX,
              },
            ],
          },
        },
      },
    });

    const res = createResponse();
    await handler(createRequest(), res as any);

    expect(res.statusCode).toBe(200);
    expect(grantLifetimeMembershipMock).not.toHaveBeenCalled();
    // Recurring renewal flows through the normal subscription-state mapper.
    expect(applyProStripeStateMock).toHaveBeenCalledTimes(1);
    expect(applyProStripeStateMock).toHaveBeenCalledWith(
      expect.objectContaining({ pubkey: "seller-pubkey", term: "monthly" })
    );
  });

  it("does NOT grant lifetime for a subscription that isn't tagged as a Pro membership", async () => {
    constructEventMock.mockReturnValue({
      id: "evt_other_sub",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_other",
          status: "active",
          customer: "cus_other",
          metadata: {},
          items: { data: [{ price: { recurring: { interval: "month" } } }] },
        },
      },
    });

    const res = createResponse();
    await handler(createRequest(), res as any);

    expect(res.statusCode).toBe(200);
    expect(grantLifetimeMembershipMock).not.toHaveBeenCalled();
    expect(applyProStripeStateMock).not.toHaveBeenCalled();
  });
});
