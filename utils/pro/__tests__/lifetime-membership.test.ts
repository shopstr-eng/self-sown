// Tests for the lifetime (Wrangler) membership flow: the sticky-lifetime guard
// in applyStripeSubscriptionToMembership (which must keep a lifetime member from
// being downgraded or kept on a recurring charge across every webhook ordering),
// pubkey resolution from subscription metadata, and the resolver's lifetime
// override that makes entitlement survive any timeline/status.

const getProMembershipMock = jest.fn();
const getProMembershipBySubscriptionMock = jest.fn();
const applyProStripeStateMock = jest.fn();
const syncProStripeMetaMock = jest.fn();
const grantLifetimeMembershipMock = jest.fn();
const cancelMock = jest.fn();
const getProSettingMock = jest.fn();
const setProSettingMock = jest.fn();
const sendLingeringAlertMock = jest.fn();

jest.mock("@/utils/db/pro-membership", () => ({
  getProMembership: (...args: unknown[]) => getProMembershipMock(...args),
  getProMembershipBySubscription: (...args: unknown[]) =>
    getProMembershipBySubscriptionMock(...args),
  applyProStripeState: (...args: unknown[]) => applyProStripeStateMock(...args),
  syncProStripeMeta: (...args: unknown[]) => syncProStripeMetaMock(...args),
  grantLifetimeMembership: (...args: unknown[]) =>
    grantLifetimeMembershipMock(...args),
  // Unused-by-these-tests imports that membership.ts pulls in at module load.
  grantProTrialIfMissing: jest.fn(),
  listExistingStallPubkeys: jest.fn(),
  listPaidProManualInvoices: jest.fn(),
  listSettledManualInvoicesMissingCoverage: jest.fn(),
  setProManualInvoiceCoverage: jest.fn(),
  getProSetting: (...args: unknown[]) => getProSettingMock(...args),
  setProSetting: (...args: unknown[]) => setProSettingMock(...args),
}));

// Keep the real mapStripeSubscription so we genuinely exercise pubkey resolution
// from `sub.metadata.mmProPubkey`; only stub the Stripe client + invoice list.
jest.mock("@/utils/pro/stripe-pro", () => {
  const actual = jest.requireActual("@/utils/pro/stripe-pro");
  return {
    ...actual,
    getProStripe: () => ({ subscriptions: { cancel: cancelMock } }),
    listProStripeInvoices: jest.fn(),
  };
});

jest.mock("@/utils/stripe/retry-service", () => ({
  withStripeRetry: (fn: () => unknown) => fn(),
  stableIdempotencyKey: jest.fn(),
}));

jest.mock("@/utils/db/db-service", () => ({
  getSellerNotificationEmail: jest.fn(),
}));

jest.mock("@/utils/email/email-service", () => ({
  sendProReceipt: jest.fn(),
  sendProLifetimeLingeringCancelAlert: (...args: unknown[]) =>
    sendLingeringAlertMock(...args),
}));

jest.mock("@/utils/nostr/server-nostr-helpers", () => ({
  sendServerSideNostrDM: jest.fn(),
}));

import {
  applyStripeSubscriptionToMembership,
  cancelExistingProSubscription,
} from "@/utils/pro/membership";
import {
  resolveMembershipStatus,
  membershipView,
} from "@/utils/pro/membership-status";

const FUTURE_UNIX = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;

function makeSub(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_123",
    status: "active",
    customer: "cus_123",
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
    ...overrides,
  } as any;
}

describe("applyStripeSubscriptionToMembership — sticky-lifetime guard", () => {
  beforeEach(() => {
    getProMembershipMock.mockReset();
    getProMembershipBySubscriptionMock.mockReset();
    applyProStripeStateMock.mockReset().mockResolvedValue(undefined);
    syncProStripeMetaMock.mockReset().mockResolvedValue(undefined);
    grantLifetimeMembershipMock.mockReset().mockResolvedValue(undefined);
    cancelMock.mockReset().mockResolvedValue({});
    getProSettingMock.mockReset().mockResolvedValue(null);
    setProSettingMock.mockReset().mockResolvedValue(undefined);
    sendLingeringAlertMock.mockReset().mockResolvedValue(true);
  });

  it("cancels a lingering live subscription and writes NO membership state for a lifetime member", async () => {
    getProMembershipMock.mockResolvedValue({ lifetime: true });

    await applyStripeSubscriptionToMembership(makeSub({ status: "active" }));

    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(cancelMock).toHaveBeenCalledWith("sub_123");
    expect(applyProStripeStateMock).not.toHaveBeenCalled();
    expect(syncProStripeMetaMock).not.toHaveBeenCalled();
  });

  it("does NOT attempt cancellation for a lifetime member whose sub is already canceled (deleted-after-grant)", async () => {
    getProMembershipMock.mockResolvedValue({ lifetime: true });

    await applyStripeSubscriptionToMembership(makeSub({ status: "canceled" }));

    expect(cancelMock).not.toHaveBeenCalled();
    expect(applyProStripeStateMock).not.toHaveBeenCalled();
    expect(syncProStripeMetaMock).not.toHaveBeenCalled();
  });

  it("does NOT attempt cancellation for a lifetime member whose sub is incomplete_expired", async () => {
    getProMembershipMock.mockResolvedValue({ lifetime: true });

    await applyStripeSubscriptionToMembership(
      makeSub({ status: "incomplete_expired" })
    );

    expect(cancelMock).not.toHaveBeenCalled();
    expect(applyProStripeStateMock).not.toHaveBeenCalled();
    expect(syncProStripeMetaMock).not.toHaveBeenCalled();
  });

  it("resolves the pubkey from sub.metadata.mmProPubkey without a DB subscription lookup", async () => {
    getProMembershipMock.mockResolvedValue({ lifetime: true });

    await applyStripeSubscriptionToMembership(makeSub({ status: "active" }));

    // Metadata carried the pubkey, so we never look it up by subscription id —
    // the guard still fires even though the lifetime grant nulled the DB
    // stripe_subscription_id.
    expect(getProMembershipBySubscriptionMock).not.toHaveBeenCalled();
    expect(getProMembershipMock).toHaveBeenCalledWith("seller-pubkey");
    expect(cancelMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to a subscription-id lookup when metadata has no pubkey", async () => {
    getProMembershipBySubscriptionMock.mockResolvedValue({
      pubkey: "resolved-pubkey",
    });
    getProMembershipMock.mockResolvedValue({ lifetime: true });

    await applyStripeSubscriptionToMembership(
      makeSub({ status: "active", metadata: { proMembership: "true" } })
    );

    expect(getProMembershipBySubscriptionMock).toHaveBeenCalledWith("sub_123");
    expect(getProMembershipMock).toHaveBeenCalledWith("resolved-pubkey");
    expect(cancelMock).toHaveBeenCalledTimes(1);
  });

  it("swallows a Stripe cancellation failure (best-effort) and still writes no membership state", async () => {
    getProMembershipMock.mockResolvedValue({ lifetime: true });
    cancelMock.mockRejectedValue(new Error("stripe down"));

    await expect(
      applyStripeSubscriptionToMembership(makeSub({ status: "active" }))
    ).resolves.toBeUndefined();

    expect(applyProStripeStateMock).not.toHaveBeenCalled();
    expect(syncProStripeMetaMock).not.toHaveBeenCalled();
  });

  it("does NOT fire the lifetime guard for a normal active subscriber — grants via applyProStripeState", async () => {
    getProMembershipMock.mockResolvedValue({ lifetime: false });

    await applyStripeSubscriptionToMembership(makeSub({ status: "active" }));

    expect(cancelMock).not.toHaveBeenCalled();
    expect(applyProStripeStateMock).toHaveBeenCalledTimes(1);
    expect(applyProStripeStateMock).toHaveBeenCalledWith(
      expect.objectContaining({ pubkey: "seller-pubkey", term: "monthly" })
    );
    expect(syncProStripeMetaMock).not.toHaveBeenCalled();
  });

  it("syncs metadata only (no grant, no cancel) for a normal canceled subscriber", async () => {
    getProMembershipMock.mockResolvedValue({ lifetime: false });

    await applyStripeSubscriptionToMembership(makeSub({ status: "canceled" }));

    expect(cancelMock).not.toHaveBeenCalled();
    expect(applyProStripeStateMock).not.toHaveBeenCalled();
    expect(syncProStripeMetaMock).toHaveBeenCalledTimes(1);
  });
});

describe("lifetime lingering-subscription cancel — structured log events", () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  const TAG = "[pro_lifetime_lingering_subscription_cancel]";

  // Pull the JSON payload object out of every log call that used the tag.
  function loggedPayloads(spy: jest.SpyInstance): any[] {
    return spy.mock.calls
      .filter((call) => call[0] === TAG)
      .map((call) => JSON.parse(call[1] as string));
  }

  beforeEach(() => {
    getProMembershipMock.mockReset();
    getProMembershipBySubscriptionMock.mockReset();
    applyProStripeStateMock.mockReset().mockResolvedValue(undefined);
    syncProStripeMetaMock.mockReset().mockResolvedValue(undefined);
    grantLifetimeMembershipMock.mockReset().mockResolvedValue(undefined);
    cancelMock.mockReset().mockResolvedValue({});
    getProSettingMock.mockReset().mockResolvedValue(null);
    setProSettingMock.mockReset().mockResolvedValue(undefined);
    sendLingeringAlertMock.mockReset().mockResolvedValue(true);
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    warnSpy.mockClear();
    errorSpy.mockClear();
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("logs attempt + success on the renewal-webhook auto-retry path", async () => {
    getProMembershipMock.mockResolvedValue({ lifetime: true });

    await applyStripeSubscriptionToMembership(makeSub({ status: "active" }));

    const events = loggedPayloads(warnSpy);
    expect(events).toEqual([
      expect.objectContaining({
        event: "pro_lifetime_lingering_subscription_cancel",
        outcome: "attempt",
        source: "renewal_webhook",
        pubkey: "seller-pubkey",
        subscriptionId: "sub_123",
      }),
      expect.objectContaining({
        outcome: "success",
        source: "renewal_webhook",
        subscriptionId: "sub_123",
      }),
    ]);
    expect(loggedPayloads(errorSpy)).toEqual([]);
  });

  it("logs attempt then failure (with the error message) when Stripe cancel throws on the webhook path", async () => {
    getProMembershipMock.mockResolvedValue({ lifetime: true });
    cancelMock.mockRejectedValue(new Error("stripe down"));

    await applyStripeSubscriptionToMembership(makeSub({ status: "active" }));

    expect(loggedPayloads(warnSpy)).toEqual([
      expect.objectContaining({
        outcome: "attempt",
        source: "renewal_webhook",
      }),
    ]);
    expect(loggedPayloads(errorSpy)).toEqual([
      expect.objectContaining({
        outcome: "failure",
        source: "renewal_webhook",
        subscriptionId: "sub_123",
        error: "stripe down",
      }),
    ]);
  });

  it("does not log a cancel event when there's no lingering subscription to cancel", async () => {
    getProMembershipMock.mockResolvedValue({ lifetime: true });

    await applyStripeSubscriptionToMembership(makeSub({ status: "canceled" }));

    expect(loggedPayloads(warnSpy)).toEqual([]);
    expect(loggedPayloads(errorSpy)).toEqual([]);
  });

  it("logs attempt + success on the at-purchase cancellation path", async () => {
    getProMembershipMock.mockResolvedValue({
      stripe_subscription_id: "sub_purchase",
    });

    await cancelExistingProSubscription("buyer-pubkey");

    expect(cancelMock).toHaveBeenCalledWith("sub_purchase");
    expect(loggedPayloads(warnSpy)).toEqual([
      expect.objectContaining({
        outcome: "attempt",
        source: "purchase",
        pubkey: "buyer-pubkey",
        subscriptionId: "sub_purchase",
      }),
      expect.objectContaining({ outcome: "success", source: "purchase" }),
    ]);
  });

  it("logs failure (best-effort, no throw) when the at-purchase cancel fails", async () => {
    getProMembershipMock.mockResolvedValue({
      stripe_subscription_id: "sub_purchase",
    });
    cancelMock.mockRejectedValue(new Error("card network error"));

    await expect(
      cancelExistingProSubscription("buyer-pubkey")
    ).resolves.toBeUndefined();

    expect(loggedPayloads(errorSpy)).toEqual([
      expect.objectContaining({
        outcome: "failure",
        source: "purchase",
        subscriptionId: "sub_purchase",
        error: "card network error",
      }),
    ]);
  });

  it("logs nothing and never calls Stripe when the seller has no subscription", async () => {
    getProMembershipMock.mockResolvedValue({ stripe_subscription_id: null });

    await cancelExistingProSubscription("buyer-pubkey");

    expect(cancelMock).not.toHaveBeenCalled();
    expect(loggedPayloads(warnSpy)).toEqual([]);
    expect(loggedPayloads(errorSpy)).toEqual([]);
  });
});

describe("lifetime lingering-subscription cancel — admin alert email", () => {
  beforeEach(() => {
    getProMembershipMock.mockReset();
    getProMembershipBySubscriptionMock.mockReset();
    applyProStripeStateMock.mockReset().mockResolvedValue(undefined);
    syncProStripeMetaMock.mockReset().mockResolvedValue(undefined);
    grantLifetimeMembershipMock.mockReset().mockResolvedValue(undefined);
    cancelMock.mockReset().mockResolvedValue({});
    getProSettingMock.mockReset().mockResolvedValue(null);
    setProSettingMock.mockReset().mockResolvedValue(undefined);
    sendLingeringAlertMock.mockReset().mockResolvedValue(true);
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("emails the operator and records the dedup timestamp when a webhook cancel fails", async () => {
    getProMembershipMock.mockResolvedValue({ lifetime: true });
    cancelMock.mockRejectedValue(new Error("stripe down"));

    await applyStripeSubscriptionToMembership(makeSub({ status: "active" }));

    expect(sendLingeringAlertMock).toHaveBeenCalledTimes(1);
    expect(sendLingeringAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pubkey: "seller-pubkey",
        subscriptionId: "sub_123",
        source: "renewal_webhook",
        error: "stripe down",
      })
    );
    expect(setProSettingMock).toHaveBeenCalledWith(
      "lifetime_lingering_cancel_alert:sub_123",
      expect.any(String)
    );
  });

  it("emails the operator on an at-purchase cancel failure", async () => {
    getProMembershipMock.mockResolvedValue({
      stripe_subscription_id: "sub_purchase",
    });
    cancelMock.mockRejectedValue(new Error("card network error"));

    await cancelExistingProSubscription("buyer-pubkey");

    expect(sendLingeringAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pubkey: "buyer-pubkey",
        subscriptionId: "sub_purchase",
        source: "purchase",
        error: "card network error",
      })
    );
    expect(setProSettingMock).toHaveBeenCalledWith(
      "lifetime_lingering_cancel_alert:sub_purchase",
      expect.any(String)
    );
  });

  it("does NOT email or re-record when an alert for the same subscription went out recently (dedup)", async () => {
    getProMembershipMock.mockResolvedValue({ lifetime: true });
    cancelMock.mockRejectedValue(new Error("stripe down"));
    getProSettingMock.mockResolvedValue(new Date().toISOString());

    await applyStripeSubscriptionToMembership(makeSub({ status: "active" }));

    expect(sendLingeringAlertMock).not.toHaveBeenCalled();
    expect(setProSettingMock).not.toHaveBeenCalled();
  });

  it("re-alerts once the cooldown window has elapsed", async () => {
    getProMembershipMock.mockResolvedValue({ lifetime: true });
    cancelMock.mockRejectedValue(new Error("stripe down"));
    const twoDaysAgo = new Date(
      Date.now() - 2 * 24 * 60 * 60 * 1000
    ).toISOString();
    getProSettingMock.mockResolvedValue(twoDaysAgo);

    await applyStripeSubscriptionToMembership(makeSub({ status: "active" }));

    expect(sendLingeringAlertMock).toHaveBeenCalledTimes(1);
    expect(setProSettingMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT record the dedup timestamp when the alert email fails to send", async () => {
    getProMembershipMock.mockResolvedValue({ lifetime: true });
    cancelMock.mockRejectedValue(new Error("stripe down"));
    sendLingeringAlertMock.mockResolvedValue(false);

    await applyStripeSubscriptionToMembership(makeSub({ status: "active" }));

    expect(sendLingeringAlertMock).toHaveBeenCalledTimes(1);
    expect(setProSettingMock).not.toHaveBeenCalled();
  });

  it("never alerts when the cancel succeeds", async () => {
    getProMembershipMock.mockResolvedValue({ lifetime: true });

    await applyStripeSubscriptionToMembership(makeSub({ status: "active" }));

    expect(sendLingeringAlertMock).not.toHaveBeenCalled();
  });

  it("swallows an alert-path failure (best-effort) and never throws out of the webhook", async () => {
    getProMembershipMock.mockResolvedValue({ lifetime: true });
    cancelMock.mockRejectedValue(new Error("stripe down"));
    sendLingeringAlertMock.mockRejectedValue(new Error("mail down"));

    await expect(
      applyStripeSubscriptionToMembership(makeSub({ status: "active" }))
    ).resolves.toBeUndefined();
  });
});

describe("resolveMembershipStatus — lifetime entitlement survives every timeline", () => {
  it("returns active for a lifetime row with no timeline at all", () => {
    expect(resolveMembershipStatus({ lifetime: true } as any)).toBe("active");
  });

  it("returns active for a lifetime row even with a fully-elapsed timeline and canceled status", () => {
    const past = new Date(Date.now() - 1000 * 60 * 60 * 24 * 365).toISOString();
    const row = {
      lifetime: true,
      status: "canceled",
      current_period_end: past,
      grace_until: past,
      readonly_until: past,
      cancel_at_period_end: true,
    } as any;
    expect(resolveMembershipStatus(row)).toBe("active");
  });

  it("membershipView surfaces isLifetime and nulls the renewal/lapse dates", () => {
    const past = new Date(Date.now() - 1000 * 60 * 60 * 24 * 365).toISOString();
    const view = membershipView("seller-pubkey", {
      lifetime: true,
      status: "canceled",
      current_period_end: past,
      grace_until: past,
      readonly_until: past,
    } as any);

    expect(view.isLifetime).toBe(true);
    expect(view.isPro).toBe(true);
    expect(view.status).toBe("active");
    expect(view.currentPeriodEnd).toBeNull();
    expect(view.graceUntil).toBeNull();
    expect(view.readonlyUntil).toBeNull();
  });
});
