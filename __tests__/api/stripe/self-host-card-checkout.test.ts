/** @jest-environment node */

// Route-level lockdown for self-host (Wrangler/lifetime) card checkout. On a
// self-host instance card charges land DIRECTLY on the owner's OWN standard
// Stripe account, so the payment route and the card-availability route must
// fail closed for anything that isn't the configured tenant's own single-seller
// checkout. These tests drive the routes with the heavy deps mocked and the
// self-host config controlled per-test, so a future refactor can't silently
// re-open a charge path.

const applyRateLimitMock = jest.fn();
const getStripeConnectAccountMock = jest.fn();
const getSelfHostConfigMock = jest.fn();
const isSelfHostTenantMock = jest.fn();
const stripeCreateMock = jest.fn();
const recordPendingPaymentMock = jest.fn();
const updatePendingPaymentMock = jest.fn();
const resolveDonationCutMock = jest.fn();

jest.mock("stripe", () => {
  const Stripe = jest.fn().mockImplementation(() => ({
    paymentIntents: {
      create: (...args: unknown[]) => stripeCreateMock(...args),
    },
  }));
  return { __esModule: true, default: Stripe };
});

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: (...args: unknown[]) => applyRateLimitMock(...args),
}));

jest.mock("@/utils/db/db-service", () => ({
  getStripeConnectAccount: (...args: unknown[]) =>
    getStripeConnectAccountMock(...args),
}));

jest.mock("@/utils/self-host/config", () => ({
  getSelfHostConfig: (...args: unknown[]) => getSelfHostConfigMock(...args),
  isSelfHostTenant: (...args: unknown[]) => isSelfHostTenantMock(...args),
}));

jest.mock("@/utils/stripe/pending-payments", () => ({
  recordPendingPayment: (...args: unknown[]) =>
    recordPendingPaymentMock(...args),
  updatePendingPayment: (...args: unknown[]) =>
    updatePendingPaymentMock(...args),
}));

jest.mock("@/utils/stripe/donation", () => ({
  resolveDonationCut: (...args: unknown[]) => resolveDonationCutMock(...args),
}));

import createPaymentIntentHandler from "@/pages/api/stripe/create-payment-intent";
import sellerStatusHandler from "@/pages/api/stripe/connect/seller-status";

const TENANT = "a".repeat(64);
const OTHER = "b".repeat(64);

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

// A self-host config object. `enabled`/`ownStripe` are flipped per-test.
function selfHostCfg(over: Record<string, unknown> = {}) {
  return {
    enabled: true,
    tenantPubkey: TENANT,
    tenantSlug: "my-farm",
    relays: [],
    blossomServers: [],
    ownStripe: true,
    upstreamRepo: "https://github.com/shopstr-eng/milk-market",
    ...over,
  };
}

const ORIGINAL_KEY = process.env.STRIPE_SECRET_KEY;

beforeEach(() => {
  applyRateLimitMock.mockReset().mockReturnValue(true);
  getStripeConnectAccountMock.mockReset().mockResolvedValue(null);
  getSelfHostConfigMock.mockReset();
  // Tenant match: only the configured TENANT pubkey is the tenant.
  isSelfHostTenantMock
    .mockReset()
    .mockImplementation(
      (pk: unknown) => typeof pk === "string" && pk.toLowerCase() === TENANT
    );
  stripeCreateMock
    .mockReset()
    .mockResolvedValue({ id: "pi_123", client_secret: "pi_123_secret" });
  recordPendingPaymentMock.mockReset().mockResolvedValue(undefined);
  updatePendingPaymentMock.mockReset().mockResolvedValue(undefined);
  resolveDonationCutMock
    .mockReset()
    .mockResolvedValue({ percent: 0, cutSmallest: 0 });
  process.env.STRIPE_SECRET_KEY = "sk_test_owner";
});

afterAll(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = ORIGINAL_KEY;
});

describe("POST /api/stripe/create-payment-intent — self-host guards", () => {
  it("rejects a multi-seller cart on a self-host instance", async () => {
    getSelfHostConfigMock.mockReturnValue(selfHostCfg());
    const res = makeRes();
    await createPaymentIntentHandler(
      {
        method: "POST",
        body: {
          amount: 10,
          currency: "usd",
          metadata: { sellerPubkey: TENANT },
          sellerSplits: [
            { sellerPubkey: TENANT, amountSmallest: 500, currency: "usd" },
            { sellerPubkey: OTHER, amountSmallest: 500, currency: "usd" },
          ],
        },
      } as any,
      res as any
    );
    expect(res.statusCode).toBe(400);
    expect(String((res.body as any).error)).toMatch(/single-seller/i);
    expect(stripeCreateMock).not.toHaveBeenCalled();
  });

  it("rejects when own-Stripe is turned off", async () => {
    getSelfHostConfigMock.mockReturnValue(selfHostCfg({ ownStripe: false }));
    const res = makeRes();
    await createPaymentIntentHandler(
      {
        method: "POST",
        body: {
          amount: 10,
          currency: "usd",
          metadata: { sellerPubkey: TENANT },
        },
      } as any,
      res as any
    );
    expect(res.statusCode).toBe(400);
    expect(String((res.body as any).error)).toMatch(/not enabled/i);
    expect(stripeCreateMock).not.toHaveBeenCalled();
  });

  it("rejects when no Stripe secret key is configured", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    getSelfHostConfigMock.mockReturnValue(selfHostCfg());
    const res = makeRes();
    await createPaymentIntentHandler(
      {
        method: "POST",
        body: {
          amount: 10,
          currency: "usd",
          metadata: { sellerPubkey: TENANT },
        },
      } as any,
      res as any
    );
    expect(res.statusCode).toBe(400);
    expect(String((res.body as any).error)).toMatch(/not enabled/i);
    expect(stripeCreateMock).not.toHaveBeenCalled();
  });

  it("rejects a charge for a seller that is not the configured tenant", async () => {
    getSelfHostConfigMock.mockReturnValue(selfHostCfg());
    const res = makeRes();
    await createPaymentIntentHandler(
      {
        method: "POST",
        body: {
          amount: 10,
          currency: "usd",
          metadata: { sellerPubkey: OTHER },
        },
      } as any,
      res as any
    );
    expect(res.statusCode).toBe(400);
    expect(String((res.body as any).error)).toMatch(/its own products/i);
    expect(stripeCreateMock).not.toHaveBeenCalled();
  });

  it("allows the tenant's own single-seller checkout when own-Stripe + key are set", async () => {
    getSelfHostConfigMock.mockReturnValue(selfHostCfg());
    const res = makeRes();
    await createPaymentIntentHandler(
      {
        method: "POST",
        body: {
          amount: 10,
          currency: "usd",
          metadata: { sellerPubkey: TENANT },
        },
      } as any,
      res as any
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as any).success).toBe(true);
    expect(stripeCreateMock).toHaveBeenCalledTimes(1);
    // Self-host forces a direct charge on the owner's own key: no Connect
    // account lookup and no stripeAccount option on the create call.
    expect(getStripeConnectAccountMock).not.toHaveBeenCalled();
    const opts = stripeCreateMock.mock.calls[0][1] ?? {};
    expect((opts as any).stripeAccount).toBeUndefined();
    expect((res.body as any).connectedAccountId).toBeUndefined();
  });

  it("settles a multi-seller cart normally when self-host is off", async () => {
    getSelfHostConfigMock.mockReturnValue(selfHostCfg({ enabled: false }));
    getStripeConnectAccountMock.mockResolvedValue({
      stripe_account_id: "acct_seller",
      charges_enabled: true,
    });
    const res = makeRes();
    await createPaymentIntentHandler(
      {
        method: "POST",
        body: {
          amount: 10,
          currency: "usd",
          sellerSplits: [
            { sellerPubkey: TENANT, amountSmallest: 500, currency: "usd" },
            { sellerPubkey: OTHER, amountSmallest: 500, currency: "usd" },
          ],
        },
      } as any,
      res as any
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as any).isMultiMerchant).toBe(true);
    expect(stripeCreateMock).toHaveBeenCalledTimes(1);
    expect(isSelfHostTenantMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/stripe/connect/seller-status — self-host card availability", () => {
  it("reports a card available for the tenant with own-Stripe + key", async () => {
    getSelfHostConfigMock.mockReturnValue(selfHostCfg());
    const res = makeRes();
    await sellerStatusHandler(
      { method: "POST", body: { pubkey: TENANT } } as any,
      res as any
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        hasStripeAccount: true,
        chargesEnabled: true,
      })
    );
    // Self-host never touches the Connect table.
    expect(getStripeConnectAccountMock).not.toHaveBeenCalled();
  });

  it("reports NO card for any pubkey that is not the tenant", async () => {
    getSelfHostConfigMock.mockReturnValue(selfHostCfg());
    const res = makeRes();
    await sellerStatusHandler(
      { method: "POST", body: { pubkey: OTHER } } as any,
      res as any
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        hasStripeAccount: false,
        chargesEnabled: false,
      })
    );
    expect(getStripeConnectAccountMock).not.toHaveBeenCalled();
  });

  it("reports NO card when own-Stripe is off", async () => {
    getSelfHostConfigMock.mockReturnValue(selfHostCfg({ ownStripe: false }));
    const res = makeRes();
    await sellerStatusHandler(
      { method: "POST", body: { pubkey: TENANT } } as any,
      res as any
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as any).hasStripeAccount).toBe(false);
  });

  it("reports NO card when no Stripe key is configured", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    getSelfHostConfigMock.mockReturnValue(selfHostCfg());
    const res = makeRes();
    await sellerStatusHandler(
      { method: "POST", body: { pubkey: TENANT } } as any,
      res as any
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as any).hasStripeAccount).toBe(false);
  });

  it("falls back to the Connect table when self-host is off", async () => {
    getSelfHostConfigMock.mockReturnValue(selfHostCfg({ enabled: false }));
    getStripeConnectAccountMock.mockResolvedValue({
      stripe_account_id: "acct_seller",
      charges_enabled: true,
      onboarding_complete: true,
    });
    const res = makeRes();
    await sellerStatusHandler(
      { method: "POST", body: { pubkey: OTHER } } as any,
      res as any
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        hasStripeAccount: true,
        chargesEnabled: true,
        connectedAccountId: "acct_seller",
      })
    );
    expect(getStripeConnectAccountMock).toHaveBeenCalledWith(OTHER);
    expect(isSelfHostTenantMock).not.toHaveBeenCalled();
  });
});
