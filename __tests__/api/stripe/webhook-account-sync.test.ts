/** @jest-environment node */

// Route-level coverage for account.updated / account.application.deauthorized
// mirroring Stripe-reported Connect account state into the seller-side
// stripe_connect_accounts cache (previously only the affiliates table was
// synced, so seller flags like charges_enabled could go stale and green-light
// transfers Stripe would reject).

const mockConstructEvent = jest.fn();

jest.mock("stripe", () => {
  const Stripe = jest.fn().mockImplementation(() => ({
    webhooks: {
      constructEvent: (...args: any[]) => mockConstructEvent(...args),
    },
  }));
  return { __esModule: true, default: Stripe };
});

const mockSyncStripeConnectAccountState = jest.fn();
const mockMarkStripeConnectDeauthorized = jest.fn();

jest.mock("@/utils/db/db-service", () => ({
  getStripeConnectAccount: jest.fn(async () => null),
  getSellerNotificationEmail: jest.fn(async () => null),
  getSubscriptionByStripeId: jest.fn(async () => null),
  syncStripeConnectAccountStateByStripeId: (...args: any[]) =>
    mockSyncStripeConnectAccountState(...args),
  markStripeConnectDeauthorizedByStripeId: (...args: any[]) =>
    mockMarkStripeConnectDeauthorized(...args),
}));

const mockSyncAffiliateStripeAccountState = jest.fn(
  async (..._args: any[]): Promise<number | null> => null
);
const mockMarkAffiliateStripeDeauthorized = jest.fn(
  async (..._args: any[]): Promise<number | null> => null
);

jest.mock("@/utils/db/affiliates", () => ({
  reverseReferralsForOrder: jest.fn(async () => undefined),
  syncAffiliateStripeAccountState: (params: any) =>
    mockSyncAffiliateStripeAccountState(params),
  markAffiliateStripeDeauthorized: (acctId: any) =>
    mockMarkAffiliateStripeDeauthorized(acctId),
}));

jest.mock("@/utils/email/email-service", () => ({
  sendPaymentFailedToBuyer: jest.fn(async () => undefined),
  sendPaymentFailedToSeller: jest.fn(async () => undefined),
  sendTransferFailureAlert: jest.fn(async () => undefined),
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

import webhookHandler from "@/pages/api/stripe/webhook";

const SELLER_PUBKEY = "c".repeat(64);
const SELLER_ACCT = "acct_seller_123";

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

const originalSecret = process.env.STRIPE_WEBHOOK_SECRET;
const originalConnectSecret = process.env.STRIPE_WEBHOOK_CONNECT_SECRET;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  delete process.env.STRIPE_WEBHOOK_CONNECT_SECRET;
  mockClaimStripeEvent.mockResolvedValue(true);
  mockFinalizeStripeEvent.mockResolvedValue(undefined);
  mockReleaseStripeEvent.mockResolvedValue(undefined);
  mockSyncAffiliateStripeAccountState.mockResolvedValue(null);
  mockMarkAffiliateStripeDeauthorized.mockResolvedValue(null);
  mockSyncStripeConnectAccountState.mockResolvedValue(null);
  mockMarkStripeConnectDeauthorized.mockResolvedValue(null);
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  (console.log as jest.Mock).mockRestore?.();
  (console.error as jest.Mock).mockRestore?.();
  (console.warn as jest.Mock).mockRestore?.();
});

afterAll(() => {
  process.env.STRIPE_WEBHOOK_SECRET = originalSecret;
  process.env.STRIPE_WEBHOOK_CONNECT_SECRET = originalConnectSecret;
});

function fireAccountUpdated(
  account: Record<string, unknown>,
  eventId = "evt_account_updated"
) {
  mockConstructEvent.mockReturnValue({
    id: eventId,
    type: "account.updated",
    data: { object: { id: SELLER_ACCT, ...account } },
  });
}

function fireDeauthorized(
  acctId: string | undefined,
  eventId = "evt_deauthorized"
) {
  mockConstructEvent.mockReturnValue({
    id: eventId,
    type: "account.application.deauthorized",
    account: acctId,
    data: { object: { id: "ca_app" } },
  });
}

describe("POST /api/stripe/webhook — account.updated seller cache sync", () => {
  it("syncs a matching seller row and logs SELLER_STRIPE_ACCOUNT_UPDATED", async () => {
    mockSyncStripeConnectAccountState.mockResolvedValue(SELLER_PUBKEY);
    fireAccountUpdated({
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: true,
    });

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(mockSyncStripeConnectAccountState).toHaveBeenCalledWith({
      stripeAccountId: SELLER_ACCT,
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: true,
    });
    const logCalls = (console.log as jest.Mock).mock.calls
      .map((args) => String(args[0]))
      .join("\n");
    expect(logCalls).toContain("SELLER_STRIPE_ACCOUNT_UPDATED");
    expect(logCalls).toContain(SELLER_PUBKEY);
    expect(logCalls).toContain(SELLER_ACCT);
  });

  it("passes details_submitted through unchanged even when a capability is disabled", async () => {
    // onboarding status must mirror details_submitted alone (matching the
    // account-status refresh path): a restricted account is still onboarded.
    mockSyncStripeConnectAccountState.mockResolvedValue(SELLER_PUBKEY);
    fireAccountUpdated({
      charges_enabled: false,
      payouts_enabled: true,
      details_submitted: true,
    });

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(mockSyncStripeConnectAccountState).toHaveBeenCalledWith({
      stripeAccountId: SELLER_ACCT,
      chargesEnabled: false,
      payoutsEnabled: true,
      detailsSubmitted: true,
    });
  });

  it("no-ops quietly when the account is not a marketplace seller", async () => {
    mockSyncStripeConnectAccountState.mockResolvedValue(null);
    fireAccountUpdated({
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
    });

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    const logCalls = (console.log as jest.Mock).mock.calls
      .map((args) => String(args[0]))
      .join("\n");
    expect(logCalls).not.toContain("SELLER_STRIPE_ACCOUNT_UPDATED");
    expect(mockFinalizeStripeEvent).toHaveBeenCalledWith("evt_account_updated");
    expect(mockReleaseStripeEvent).not.toHaveBeenCalled();
  });

  it("still syncs the affiliate table alongside the seller row", async () => {
    mockSyncAffiliateStripeAccountState.mockResolvedValue(7);
    mockSyncStripeConnectAccountState.mockResolvedValue(null);
    fireAccountUpdated({
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
    });

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(mockSyncAffiliateStripeAccountState).toHaveBeenCalledWith({
      stripeAccountId: SELLER_ACCT,
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
    });
    const logCalls = (console.log as jest.Mock).mock.calls
      .map((args) => String(args[0]))
      .join("\n");
    expect(logCalls).toContain("AFFILIATE_STRIPE_ACCOUNT_UPDATED");
  });

  it("500s and releases the claim when the seller sync hits a DB outage, so Stripe retries", async () => {
    // A swallowed DB error would leave charges_enabled stale — a deauthorized
    // or restricted seller would keep looking chargeable. Fail loudly instead.
    mockSyncStripeConnectAccountState.mockRejectedValue(new Error("db down"));
    fireAccountUpdated({
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: true,
    });

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(500);
    expect(mockReleaseStripeEvent).toHaveBeenCalledWith("evt_account_updated");
    expect(mockFinalizeStripeEvent).not.toHaveBeenCalled();
  });
});

describe("POST /api/stripe/webhook — account.application.deauthorized seller cache sync", () => {
  it("clears flags on a matching seller row and logs SELLER_STRIPE_DEAUTHORIZED", async () => {
    mockMarkStripeConnectDeauthorized.mockResolvedValue(SELLER_PUBKEY);
    fireDeauthorized(SELLER_ACCT);

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(mockMarkStripeConnectDeauthorized).toHaveBeenCalledWith(SELLER_ACCT);
    const logCalls = (console.log as jest.Mock).mock.calls
      .map((args) => String(args[0]))
      .join("\n");
    expect(logCalls).toContain("SELLER_STRIPE_DEAUTHORIZED");
    expect(logCalls).toContain(SELLER_PUBKEY);
    expect(logCalls).toContain(SELLER_ACCT);
  });

  it("no-ops quietly when the account is not a marketplace seller", async () => {
    mockMarkStripeConnectDeauthorized.mockResolvedValue(null);
    fireDeauthorized("acct_affiliate_only");

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(mockMarkStripeConnectDeauthorized).toHaveBeenCalledWith(
      "acct_affiliate_only"
    );
    const logCalls = (console.log as jest.Mock).mock.calls
      .map((args) => String(args[0]))
      .join("\n");
    expect(logCalls).not.toContain("SELLER_STRIPE_DEAUTHORIZED");
    expect(mockFinalizeStripeEvent).toHaveBeenCalledWith("evt_deauthorized");
  });

  it("does nothing when the event carries no account id", async () => {
    fireDeauthorized(undefined);

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(mockMarkStripeConnectDeauthorized).not.toHaveBeenCalled();
    expect(mockMarkAffiliateStripeDeauthorized).not.toHaveBeenCalled();
  });

  it("500s and releases the claim when the seller sync hits a DB outage, so Stripe retries", async () => {
    mockMarkStripeConnectDeauthorized.mockRejectedValue(new Error("db down"));
    fireDeauthorized(SELLER_ACCT);

    const res = makeRes();
    await webhookHandler(makeReq(), res);

    expect(res.statusCode).toBe(500);
    expect(mockReleaseStripeEvent).toHaveBeenCalledWith("evt_deauthorized");
    expect(mockFinalizeStripeEvent).not.toHaveBeenCalled();
  });
});
