/** @jest-environment node */

// Route-level coverage for the NON-self-host card-checkout path of
// pages/api/stripe/create-payment-intent.ts. This is the heavily-used hosted
// path: single-seller direct charges via Stripe Connect, the per-seller
// sales-tax gate (client-sent tax is never trusted), the platform donation
// application_fee computed on the PRE-TAX base, and the multi-merchant
// per-seller "Stripe not enabled" rejection. These drive the route with the
// heavy deps mocked so a future refactor can't silently mis-charge a buyer or
// skim sales tax. Self-host is forced OFF here (covered separately in
// self-host-card-checkout.test.ts).

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

const SELLER = "c".repeat(64);
const SELLER_B = "d".repeat(64);

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

// Self-host OFF for every test in this file.
function hostedCfg(over: Record<string, unknown> = {}) {
  return {
    enabled: false,
    tenantPubkey: null,
    tenantSlug: null,
    relays: [],
    blossomServers: [],
    ownStripe: false,
    upstreamRepo: "https://github.com/shopstr-eng/milk-market",
    ...over,
  };
}

const ORIGINAL_KEY = process.env.STRIPE_SECRET_KEY;
const ORIGINAL_PK = process.env.NEXT_PUBLIC_MILK_MARKET_PK;

beforeEach(() => {
  applyRateLimitMock.mockReset().mockReturnValue(true);
  getStripeConnectAccountMock.mockReset().mockResolvedValue(null);
  getSelfHostConfigMock.mockReset().mockReturnValue(hostedCfg());
  isSelfHostTenantMock.mockReset().mockReturnValue(false);
  stripeCreateMock
    .mockReset()
    .mockResolvedValue({ id: "pi_123", client_secret: "pi_123_secret" });
  recordPendingPaymentMock.mockReset().mockResolvedValue(undefined);
  updatePendingPaymentMock.mockReset().mockResolvedValue(undefined);
  resolveDonationCutMock
    .mockReset()
    .mockResolvedValue({ percent: 0, cutSmallest: 0 });
  process.env.STRIPE_SECRET_KEY = "sk_test_platform";
  // Keep the seller pubkey distinct from the platform pubkey so the route
  // treats it as a connected seller (not the platform account).
  process.env.NEXT_PUBLIC_MILK_MARKET_PK = "f".repeat(64);
});

afterAll(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = ORIGINAL_KEY;
  if (ORIGINAL_PK === undefined) delete process.env.NEXT_PUBLIC_MILK_MARKET_PK;
  else process.env.NEXT_PUBLIC_MILK_MARKET_PK = ORIGINAL_PK;
});

describe("POST /api/stripe/create-payment-intent — single-seller direct charge", () => {
  it("routes the charge to the seller's connected account when charges_enabled", async () => {
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
          metadata: { sellerPubkey: SELLER },
        },
      } as any,
      res as any
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as any).success).toBe(true);
    expect(getStripeConnectAccountMock).toHaveBeenCalledWith(SELLER);
    expect(stripeCreateMock).toHaveBeenCalledTimes(1);
    // The direct charge must carry the connected account in the Stripe options
    // (second arg) so the funds land on the seller, not the platform.
    const opts = stripeCreateMock.mock.calls[0][1] ?? {};
    expect((opts as any).stripeAccount).toBe("acct_seller");
    expect((res.body as any).connectedAccountId).toBe("acct_seller");
    // No tax requested → buyer charged exactly the item amount (1000 cents).
    const params = stripeCreateMock.mock.calls[0][0] as any;
    expect(params.amount).toBe(1000);
  });

  it("treats a Stripe leg of a multi-seller card cart as a SEPARATE single-seller direct charge (no multi-merchant split)", async () => {
    // Multi-seller carts that include a Square seller charge each seller on
    // their OWN account, one at a time. The Stripe legs are sent as
    // single-seller direct charges (metadata.sellerPubkey + isCart, NO
    // sellerSplits) so each settles on that seller's connected account — they
    // must NEVER be folded into the combined multi-merchant transfer-group path.
    getStripeConnectAccountMock.mockResolvedValue({
      stripe_account_id: "acct_seller",
      charges_enabled: true,
    });
    const res = makeRes();
    await createPaymentIntentHandler(
      {
        method: "POST",
        body: {
          amount: 7,
          currency: "usd",
          metadata: { sellerPubkey: SELLER, isCart: "true" },
        },
      } as any,
      res as any
    );
    expect(res.statusCode).toBe(200);
    expect(stripeCreateMock).toHaveBeenCalledTimes(1);
    const params = stripeCreateMock.mock.calls[0][0] as any;
    const opts = stripeCreateMock.mock.calls[0][1] ?? {};
    // Direct charge on the seller's own account...
    expect((opts as any).stripeAccount).toBe("acct_seller");
    expect((res.body as any).connectedAccountId).toBe("acct_seller");
    // ...charging exactly this seller's leg (700 cents)...
    expect(params.amount).toBe(700);
    // ...and crucially NOT a multi-merchant charge.
    expect((res.body as any).isMultiMerchant).toBeUndefined();
    expect(params.transfer_group).toBeUndefined();
    expect(params.metadata.isMultiMerchant).toBeUndefined();
    expect(params.metadata.sellerSplits).toBeUndefined();
  });

  it("does NOT route to the connected account when charges_enabled is false", async () => {
    getStripeConnectAccountMock.mockResolvedValue({
      stripe_account_id: "acct_seller",
      charges_enabled: false,
    });
    const res = makeRes();
    await createPaymentIntentHandler(
      {
        method: "POST",
        body: {
          amount: 10,
          currency: "usd",
          metadata: { sellerPubkey: SELLER },
        },
      } as any,
      res as any
    );
    expect(res.statusCode).toBe(200);
    expect(stripeCreateMock).toHaveBeenCalledTimes(1);
    const opts = stripeCreateMock.mock.calls[0][1] ?? {};
    expect((opts as any).stripeAccount).toBeUndefined();
    expect((res.body as any).connectedAccountId).toBeUndefined();
  });
});

describe("POST /api/stripe/create-payment-intent — per-seller sales-tax gate", () => {
  it("adds sales tax only when the seller has tax_enabled + charges_enabled", async () => {
    getStripeConnectAccountMock.mockResolvedValue({
      stripe_account_id: "acct_seller",
      charges_enabled: true,
      tax_enabled: true,
    });
    const res = makeRes();
    await createPaymentIntentHandler(
      {
        method: "POST",
        body: {
          amount: 10,
          currency: "usd",
          salesTaxSmallest: 80,
          taxCalculationId: "taxcalc_1",
          metadata: { sellerPubkey: SELLER },
        },
      } as any,
      res as any
    );
    expect(res.statusCode).toBe(200);
    const params = stripeCreateMock.mock.calls[0][0] as any;
    // 1000 items + 80 tax.
    expect(params.amount).toBe(1080);
    expect(params.metadata.salesTaxSmallest).toBe("80");
    expect(params.metadata.taxCalculationId).toBe("taxcalc_1");
  });

  it("ignores client-sent tax when the seller does NOT have tax_enabled", async () => {
    getStripeConnectAccountMock.mockResolvedValue({
      stripe_account_id: "acct_seller",
      charges_enabled: true,
      tax_enabled: false,
    });
    const res = makeRes();
    await createPaymentIntentHandler(
      {
        method: "POST",
        body: {
          amount: 10,
          currency: "usd",
          salesTaxSmallest: 80,
          metadata: { sellerPubkey: SELLER },
        },
      } as any,
      res as any
    );
    expect(res.statusCode).toBe(200);
    const params = stripeCreateMock.mock.calls[0][0] as any;
    expect(params.amount).toBe(1000);
    expect(params.metadata.salesTaxSmallest).toBeUndefined();
  });

  it("ignores client-sent tax when the seller has no direct-charge account", async () => {
    // No connected account at all → no tax may be added even if tax requested.
    getStripeConnectAccountMock.mockResolvedValue(null);
    const res = makeRes();
    await createPaymentIntentHandler(
      {
        method: "POST",
        body: {
          amount: 10,
          currency: "usd",
          salesTaxSmallest: 80,
          metadata: { sellerPubkey: SELLER },
        },
      } as any,
      res as any
    );
    expect(res.statusCode).toBe(200);
    const params = stripeCreateMock.mock.calls[0][0] as any;
    expect(params.amount).toBe(1000);
    expect(params.metadata.salesTaxSmallest).toBeUndefined();
  });
});

describe("POST /api/stripe/create-payment-intent — donation application_fee", () => {
  it("computes the application_fee on the PRE-TAX base (items + shipping)", async () => {
    getStripeConnectAccountMock.mockResolvedValue({
      stripe_account_id: "acct_seller",
      charges_enabled: true,
      tax_enabled: true,
    });
    // Donation cut depends on the base it's given — assert the route hands it
    // the pre-tax base, not the tax-inclusive total.
    resolveDonationCutMock.mockResolvedValue({ percent: 2, cutSmallest: 20 });
    const res = makeRes();
    await createPaymentIntentHandler(
      {
        method: "POST",
        body: {
          amount: 10,
          currency: "usd",
          salesTaxSmallest: 80,
          metadata: { sellerPubkey: SELLER },
        },
      } as any,
      res as any
    );
    expect(res.statusCode).toBe(200);
    // resolveDonationCut must be called with the PRE-TAX base (1000), never
    // the tax-inclusive 1080 — taxing the donation would skim the seller's
    // remittable sales tax.
    expect(resolveDonationCutMock).toHaveBeenCalledWith(SELLER, 1000);
    const params = stripeCreateMock.mock.calls[0][0] as any;
    expect(params.application_fee_amount).toBe(20);
    // Buyer is still charged items + tax.
    expect(params.amount).toBe(1080);
    expect(params.metadata.mmDonationCutSmallest).toBe("20");
  });

  it("sets no application_fee when there is no connected account", async () => {
    getStripeConnectAccountMock.mockResolvedValue(null);
    const res = makeRes();
    await createPaymentIntentHandler(
      {
        method: "POST",
        body: {
          amount: 10,
          currency: "usd",
          metadata: { sellerPubkey: SELLER },
        },
      } as any,
      res as any
    );
    expect(res.statusCode).toBe(200);
    // Funds already land on the platform — no donation cut is resolved.
    expect(resolveDonationCutMock).not.toHaveBeenCalled();
    const params = stripeCreateMock.mock.calls[0][0] as any;
    expect(params.application_fee_amount).toBeUndefined();
  });
});

describe("POST /api/stripe/create-payment-intent — multi-merchant rejection", () => {
  it("rejects a multi-seller cart when one seller lacks Stripe", async () => {
    getStripeConnectAccountMock.mockImplementation(async (pk: string) => {
      if (pk === SELLER) {
        return { stripe_account_id: "acct_a", charges_enabled: true };
      }
      // SELLER_B has no Stripe.
      return null;
    });
    const res = makeRes();
    await createPaymentIntentHandler(
      {
        method: "POST",
        body: {
          amount: 10,
          currency: "usd",
          sellerSplits: [
            { sellerPubkey: SELLER, amountSmallest: 500, currency: "usd" },
            { sellerPubkey: SELLER_B, amountSmallest: 500, currency: "usd" },
          ],
        },
      } as any,
      res as any
    );
    expect(res.statusCode).toBe(400);
    expect(String((res.body as any).error)).toMatch(
      /does not have Stripe enabled/i
    );
    expect(stripeCreateMock).not.toHaveBeenCalled();
  });

  it("settles a multi-seller cart when every seller has Stripe", async () => {
    getStripeConnectAccountMock.mockResolvedValue({
      stripe_account_id: "acct_any",
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
            { sellerPubkey: SELLER, amountSmallest: 500, currency: "usd" },
            { sellerPubkey: SELLER_B, amountSmallest: 500, currency: "usd" },
          ],
        },
      } as any,
      res as any
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as any).isMultiMerchant).toBe(true);
    expect(stripeCreateMock).toHaveBeenCalledTimes(1);
    // Buyer charged the sum of the per-seller splits (500 + 500).
    const params = stripeCreateMock.mock.calls[0][0] as any;
    expect(params.amount).toBe(1000);
  });
});
