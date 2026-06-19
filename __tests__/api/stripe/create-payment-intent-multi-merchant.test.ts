/** @jest-environment node */

// Route-level coverage for the two intricate parts of the MULTI-MERCHANT branch
// of pages/api/stripe/create-payment-intent.ts that the single-seller suite
// (create-payment-intent-direct-charge.test.ts) does not exercise:
//
//   1. Per-split affiliate rebate clamping — an oversized
//      `affiliateRebateSmallest` must be clamped to
//      `max(splitAmount - donationCut - 1, 0)` so the seller always keeps at
//      least 1 smallest unit after the platform donation cut.
//   2. Crypto-denominated splits — each is FX-converted to USD cents via
//      `satsToUSD` (sats vs btc smallest-unit handling, exactly one ceil per
//      seller), and the SUM of the converted splits is the source of truth for
//      the buyer charge (the top-level request `amount` is informational only).
//
// Heavy deps are mocked so a future refactor can't silently mis-charge a buyer
// or mis-pay an affiliate. Self-host is forced OFF for every test here.

const applyRateLimitMock = jest.fn();
const getStripeConnectAccountMock = jest.fn();
const getSelfHostConfigMock = jest.fn();
const isSelfHostTenantMock = jest.fn();
const stripeCreateMock = jest.fn();
const recordPendingPaymentMock = jest.fn();
const updatePendingPaymentMock = jest.fn();
const resolveDonationCutMock = jest.fn();
const satsToUSDMock = jest.fn();

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

// Keep isCrypto/toSmallestUnit real (they drive the branch selection and the
// fiat path) but mock only the network-bound FX call.
jest.mock("@/utils/stripe/currency", () => {
  const actual = jest.requireActual("@/utils/stripe/currency");
  return {
    __esModule: true,
    ...actual,
    satsToUSD: (...args: unknown[]) => satsToUSDMock(...args),
  };
});

import createPaymentIntentHandler from "@/pages/api/stripe/create-payment-intent";

const SELLER_A = "c".repeat(64);
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
  getStripeConnectAccountMock
    .mockReset()
    // Every seller has a working connected account unless a test overrides it.
    .mockResolvedValue({
      stripe_account_id: "acct_any",
      charges_enabled: true,
    });
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
  satsToUSDMock.mockReset();
  process.env.STRIPE_SECRET_KEY = "sk_test_platform";
  // Distinct from any split pubkey so the route treats each split as a
  // connected seller, not the platform account.
  process.env.NEXT_PUBLIC_MILK_MARKET_PK = "f".repeat(64);
});

afterAll(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = ORIGINAL_KEY;
  if (ORIGINAL_PK === undefined) delete process.env.NEXT_PUBLIC_MILK_MARKET_PK;
  else process.env.NEXT_PUBLIC_MILK_MARKET_PK = ORIGINAL_PK;
});

describe("POST /api/stripe/create-payment-intent — per-split affiliate rebate clamping", () => {
  it("clamps an oversized rebate so the seller keeps at least 1 unit after the donation cut", async () => {
    // Donation cut of 50 on each 500-unit split → the rebate ceiling is
    // max(500 - 50 - 1, 0) = 449. A wildly oversized rebate must be clamped to
    // it, never letting the affiliate drain the seller's transfer.
    resolveDonationCutMock.mockResolvedValue({ percent: 10, cutSmallest: 50 });
    const res = makeRes();
    await createPaymentIntentHandler(
      {
        method: "POST",
        body: {
          amount: 0,
          currency: "usd",
          sellerSplits: [
            {
              sellerPubkey: SELLER_A,
              amountSmallest: 500,
              currency: "usd",
              affiliateRebateSmallest: 100000,
              affiliateAccountId: "acct_aff",
              affiliateCode: "FRIEND",
            },
            {
              sellerPubkey: SELLER_B,
              amountSmallest: 500,
              currency: "usd",
              // A reasonable rebate passes through unclamped (100 <= 449).
              affiliateRebateSmallest: 100,
            },
          ],
        },
      } as any,
      res as any
    );
    expect(res.statusCode).toBe(200);
    const splits = (res.body as any).sellerSplits as any[];
    expect(splits[0].affiliateRebateSmallest).toBe(449);
    expect(splits[0].affiliateAccountId).toBe("acct_aff");
    expect(splits[0].affiliateCode).toBe("FRIEND");
    expect(splits[1].affiliateRebateSmallest).toBe(100);
    // The clamp affects only the recorded rebate, not the buyer charge.
    const params = stripeCreateMock.mock.calls[0][0] as any;
    expect(params.amount).toBe(1000);
  });

  it("clamps the rebate to 0 when the donation cut leaves no room", async () => {
    // 50-unit split with a 50-unit donation cut → max(50 - 50 - 1, 0) = 0, so
    // no rebate can be paid even though one was requested.
    resolveDonationCutMock.mockResolvedValue({ percent: 100, cutSmallest: 50 });
    const res = makeRes();
    await createPaymentIntentHandler(
      {
        method: "POST",
        body: {
          amount: 0,
          currency: "usd",
          sellerSplits: [
            {
              sellerPubkey: SELLER_A,
              amountSmallest: 50,
              currency: "usd",
              affiliateRebateSmallest: 40,
            },
            {
              sellerPubkey: SELLER_B,
              amountSmallest: 500,
              currency: "usd",
            },
          ],
        },
      } as any,
      res as any
    );
    expect(res.statusCode).toBe(200);
    const splits = (res.body as any).sellerSplits as any[];
    expect(splits[0].affiliateRebateSmallest).toBe(0);
  });
});

describe("POST /api/stripe/create-payment-intent — crypto split FX conversion", () => {
  it("converts each crypto split to USD cents (one ceil per seller) and charges the summed splits", async () => {
    // satsToUSD returns fractional USD; the route must ceil ONCE per seller and
    // the buyer charge must equal the sum of the converted splits — not the
    // top-level request `amount`, which is informational in multi-merchant mode.
    satsToUSDMock.mockImplementation(async (sats: number) => {
      if (sats === 10000) return 1.231; // → ceil(123.1) = 124 cents
      if (sats === 20000) return 2.005; // → ceil(200.5) = 201 cents
      throw new Error(`unexpected sats ${sats}`);
    });
    const res = makeRes();
    await createPaymentIntentHandler(
      {
        method: "POST",
        body: {
          // Deliberately bogus top-level amount to prove it is ignored.
          amount: 999,
          currency: "usd",
          sellerSplits: [
            { sellerPubkey: SELLER_A, amountSmallest: 10000, currency: "sats" },
            { sellerPubkey: SELLER_B, amountSmallest: 20000, currency: "sats" },
          ],
        },
      } as any,
      res as any
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as any).isMultiMerchant).toBe(true);
    // satsToUSD called exactly once per seller.
    expect(satsToUSDMock).toHaveBeenCalledTimes(2);
    const splits = (res.body as any).sellerSplits as any[];
    expect(splits[0].amountCents).toBe(124);
    expect(splits[1].amountCents).toBe(201);
    const params = stripeCreateMock.mock.calls[0][0] as any;
    // Buyer charged the summed, converted splits (124 + 201), in USD.
    expect(params.amount).toBe(325);
    expect(params.currency).toBe("usd");
  });

  it("treats a btc split's smallest unit as sats and matches an equivalent sats split", async () => {
    // BTC's smallest unit IS the satoshi, so the legacy raw-amount path scales
    // btc by 1e8 while sats is taken as-is. 0.0002 btc and 20000 sats must both
    // resolve to 20000 sats → the same converted USD cents per seller.
    satsToUSDMock.mockImplementation(async (sats: number) => {
      if (sats === 20000) return 2.0; // → ceil(200) = 200 cents
      throw new Error(`unexpected sats ${sats}`);
    });
    const res = makeRes();
    await createPaymentIntentHandler(
      {
        method: "POST",
        body: {
          amount: 0,
          currency: "usd",
          sellerSplits: [
            // Legacy raw-amount path: btc scaled by 1e8 → 20000 sats.
            { sellerPubkey: SELLER_A, amount: 0.0002, currency: "btc" },
            // Legacy raw-amount path: sats taken as-is → 20000 sats.
            { sellerPubkey: SELLER_B, amount: 20000, currency: "sats" },
          ],
        },
      } as any,
      res as any
    );
    expect(res.statusCode).toBe(200);
    expect(satsToUSDMock).toHaveBeenCalledTimes(2);
    expect(satsToUSDMock).toHaveBeenNthCalledWith(1, 20000);
    expect(satsToUSDMock).toHaveBeenNthCalledWith(2, 20000);
    const splits = (res.body as any).sellerSplits as any[];
    expect(splits[0].amountCents).toBe(200);
    expect(splits[1].amountCents).toBe(200);
    const params = stripeCreateMock.mock.calls[0][0] as any;
    expect(params.amount).toBe(400);
  });
});
