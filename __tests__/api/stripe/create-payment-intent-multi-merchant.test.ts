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
//
// Environment note (fixed here): the Apple Pay registration assertions send
// `host: SITE_HOST` (the platform marketplace host, derived from
// NEXT_PUBLIC_BASE_URL). Apple Pay is disabled on the marketplace, so the
// route never registers that host. SITE_HOST is baked at module load
// (fallback "self-sown.com", or this environment's real
// NEXT_PUBLIC_BASE_URL), so stubbing the env to the stale hardcoded
// "https://milk.market" made the header never match and the suite
// went red after the brand rename / in any env where the var is set. The
// beforeEach below stubs NEXT_PUBLIC_BASE_URL from SITE_HOST itself so the
// two can never diverge again.

const applyRateLimitMock = jest.fn();
const getStripeConnectAccountMock = jest.fn();
const getSelfHostConfigMock = jest.fn();
const isSelfHostTenantMock = jest.fn();
const stripeCreateMock = jest.fn();
const recordPendingPaymentMock = jest.fn();
const updatePendingPaymentMock = jest.fn();
const resolveDonationCutMock = jest.fn();
const satsToUSDMock = jest.fn();
const registerApplePayDomainMock = jest.fn();
const getDomainByHostMock = jest.fn();
const lookupAffiliateCodeMock = jest.fn();

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
  isSelfHost: () => false,
}));

jest.mock("@/utils/stripe/pending-payments", () => ({
  // Keep the real authority-marker constants so this suite can't drift from
  // what the route stamps into PaymentIntent metadata.
  ...jest.requireActual("@/utils/stripe/pending-payments"),
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

jest.mock("@/utils/stripe/apple-pay", () => ({
  registerApplePayDomain: (...args: unknown[]) =>
    registerApplePayDomainMock(...args),
  normalizeRegistrableHost: jest.requireActual("@/utils/stripe/apple-pay")
    .normalizeRegistrableHost,
  trustedRegistrationHost: jest.requireActual("@/utils/stripe/apple-pay")
    .trustedRegistrationHost,
}));

jest.mock("@/utils/db/custom-domains", () => ({
  getDomainByHost: (...args: unknown[]) => getDomainByHostMock(...args),
}));

jest.mock("@/utils/db/affiliates", () => ({
  // Real pure helpers (discount/rebate math, validity, self-referral); only
  // the seller-scoped DB lookup is mocked.
  ...jest.requireActual("@/utils/db/affiliates"),
  lookupAffiliateCode: (...args: unknown[]) => lookupAffiliateCodeMock(...args),
}));

import createPaymentIntentHandler from "@/pages/api/stripe/create-payment-intent";
import { SITE_HOST } from "@/utils/site-url";

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
const ORIGINAL_PK = process.env.NEXT_PUBLIC_SELF_SOWN_PK;
const ORIGINAL_BASE_URL = process.env.NEXT_PUBLIC_BASE_URL;

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
  registerApplePayDomainMock.mockReset().mockResolvedValue(undefined);
  getDomainByHostMock.mockReset().mockResolvedValue(null);
  process.env.STRIPE_SECRET_KEY = "sk_test_platform";
  // Distinct from any split pubkey so the route treats each split as a
  // connected seller, not the platform account.
  process.env.NEXT_PUBLIC_SELF_SOWN_PK = "f".repeat(64);
  // Derive the platform origin from SITE_HOST (see header note): the Apple
  // Pay tests send `host: SITE_HOST`, and trustedRegistrationHost only
  // registers when it matches the host of NEXT_PUBLIC_BASE_URL.
  process.env.NEXT_PUBLIC_BASE_URL = `https://${SITE_HOST}`;
});

afterAll(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = ORIGINAL_KEY;
  if (ORIGINAL_PK === undefined) delete process.env.NEXT_PUBLIC_SELF_SOWN_PK;
  else process.env.NEXT_PUBLIC_SELF_SOWN_PK = ORIGINAL_PK;
  if (ORIGINAL_BASE_URL === undefined) delete process.env.NEXT_PUBLIC_BASE_URL;
  else process.env.NEXT_PUBLIC_BASE_URL = ORIGINAL_BASE_URL;
});

describe("POST /api/stripe/create-payment-intent — Apple Pay domain registration binding", () => {
  const twoSellerBody = {
    amount: 0,
    currency: "usd",
    sellerSplits: [
      { sellerPubkey: SELLER_A, amountSmallest: 500, currency: "usd" },
      { sellerPubkey: SELLER_B, amountSmallest: 500, currency: "usd" },
    ],
  };

  it("registers the platform host on the PLATFORM account for multi-seller charges", async () => {
    const res = makeRes();
    await createPaymentIntentHandler(
      {
        method: "POST",
        headers: { host: SITE_HOST },
        body: twoSellerBody,
      } as any,
      res as any
    );
    expect(res.statusCode).toBe(200);
    // Multi-seller charges run on the platform account: no connected-account
    // argument.
    expect(registerApplePayDomainMock).toHaveBeenCalledWith(SITE_HOST);
  });

  it("never registers a request-controlled Host for multi-seller charges", async () => {
    const res = makeRes();
    await createPaymentIntentHandler(
      {
        method: "POST",
        headers: { host: "attacker.example.com" },
        body: twoSellerBody,
      } as any,
      res as any
    );
    // Checkout itself is unaffected — registration just doesn't happen.
    expect(res.statusCode).toBe(200);
    expect(stripeCreateMock).toHaveBeenCalledTimes(1);
    expect(registerApplePayDomainMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/stripe/create-payment-intent — per-split affiliate rebate clamping", () => {
  it("clamps an oversized rebate so the seller keeps at least 1 unit after the donation cut", async () => {
    // Donation cut of 50 on each 500-unit split → the rebate ceiling is
    // max(500 - 50 - 1, 0) = 449. A wildly oversized rebate (from the stored
    // code config — the request's own rebate fields are ignored) must be
    // clamped to it, never letting the affiliate drain the seller's transfer.
    resolveDonationCutMock.mockResolvedValue({ percent: 10, cutSmallest: 50 });
    lookupAffiliateCodeMock.mockReset().mockImplementation((seller: string) =>
      Promise.resolve(
        seller === SELLER_A
          ? {
              id: 42,
              affiliate_id: 7,
              seller_pubkey: SELLER_A,
              code: "FRIEND",
              rebate_type: "fixed",
              rebate_value: 100000,
              buyer_discount_type: "fixed",
              buyer_discount_value: 0,
              currency: null,
              is_active: true,
              expiration: null,
              max_uses: null,
              times_used: 0,
              affiliate: {
                affiliate_pubkey: "a".repeat(64),
                stripe_account_id: "acct_aff",
              },
            }
          : {
              id: 8,
              affiliate_id: 9,
              seller_pubkey: SELLER_B,
              code: "PAL",
              rebate_type: "percent",
              rebate_value: 20,
              buyer_discount_type: "percent",
              buyer_discount_value: 0,
              currency: null,
              is_active: true,
              expiration: null,
              max_uses: null,
              times_used: 0,
              affiliate: {
                affiliate_pubkey: "b".repeat(64),
                stripe_account_id: null,
              },
            }
      )
    );
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
              affiliateCode: "FRIEND",
            },
            {
              sellerPubkey: SELLER_B,
              amountSmallest: 500,
              currency: "usd",
              // 20% of 500 = 100 — a reasonable configured rebate passes
              // through unclamped (100 <= 449).
              affiliateCode: "PAL",
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
    // no rebate can be paid even though the stored code grants one.
    resolveDonationCutMock.mockResolvedValue({ percent: 100, cutSmallest: 50 });
    lookupAffiliateCodeMock.mockReset().mockResolvedValue({
      id: 42,
      affiliate_id: 7,
      seller_pubkey: SELLER_A,
      code: "FRIEND",
      rebate_type: "fixed",
      rebate_value: 40,
      buyer_discount_type: "percent",
      buyer_discount_value: 0,
      currency: null,
      is_active: true,
      expiration: null,
      max_uses: null,
      times_used: 0,
      affiliate: { affiliate_pubkey: "a".repeat(64), stripe_account_id: null },
    });
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
              affiliateCode: "FRIEND",
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

describe("POST /api/stripe/create-payment-intent — multi-seller metadata size", () => {
  it("keeps every PaymentIntent metadata value under Stripe's 500-char cap and persists full splits in the pending record", async () => {
    // Regression: the full split-details JSON (~9 fields per seller incl.
    // donation + affiliate) measured 566 chars with just TWO sellers, so
    // Stripe rejected every multi-seller card checkout with "Metadata values
    // can have up to 500 characters". The PI metadata must stay compact while
    // the pending-payment record carries the full details.
    resolveDonationCutMock.mockResolvedValue({ percent: 5, cutSmallest: 25 });
    // The request's affiliate amount/ID fields are ignored; the record
    // carries values resolved from the stored, seller-scoped code row.
    lookupAffiliateCodeMock.mockReset().mockResolvedValue({
      id: 7,
      affiliate_id: 42,
      seller_pubkey: SELLER_A,
      code: "FRIENDOFTHEFARM",
      rebate_type: "fixed",
      rebate_value: 5, // major units — $5.00 = 500 smallest
      buyer_discount_type: "percent",
      buyer_discount_value: 0,
      currency: null,
      is_active: true,
      expiration: null,
      max_uses: null,
      times_used: 0,
      affiliate: {
        affiliate_pubkey: "a".repeat(64),
        stripe_account_id: "acct_1AffiliateA",
      },
    });
    const res = makeRes();
    await createPaymentIntentHandler(
      {
        method: "POST",
        body: {
          amount: 0,
          currency: "usd",
          productTitle: "Farm cart",
          customerEmail: "buyer@example.com",
          metadata: {
            orderId: "order_abc123",
            // Attacker-supplied copies of the server-owned membership keys:
            // they must never survive into the PaymentIntent metadata, where
            // order-email verification would trust them as seller proof.
            sellerSplitPubkeys: "e".repeat(64),
            sellerSplits: JSON.stringify([{ pubkey: "e".repeat(64) }]),
          },
          sellerSplits: [
            {
              sellerPubkey: SELLER_A,
              amountSmallest: 12500,
              currency: "usd",
              affiliateRebateSmallest: 500,
              affiliateAccountId: "acct_1AffiliateA",
              affiliateId: 42,
              affiliateCodeId: 7,
              affiliateCode: "FRIENDOFTHEFARM",
            },
            {
              sellerPubkey: SELLER_B,
              amountSmallest: 8900,
              currency: "usd",
            },
          ],
        },
      } as any,
      res as any
    );
    expect(res.statusCode).toBe(200);

    const params = stripeCreateMock.mock.calls[0][0] as any;
    // Every metadata value Stripe receives fits the 500-char cap.
    for (const [key, value] of Object.entries(params.metadata)) {
      expect(String(value).length).toBeLessThanOrEqual(500);
      expect(typeof value).toBe("string");
      void key;
    }
    // The compact membership marker lists both sellers — the server's own
    // value, not the attacker-supplied one from the request metadata.
    expect(params.metadata.sellerSplitPubkeys).toBe(`${SELLER_A},${SELLER_B}`);
    // The bulky full JSON no longer goes to Stripe, and the attacker's copy
    // is stripped rather than passed through.
    expect(params.metadata.sellerSplits).toBeUndefined();

    // The full split details (amounts, accounts, donation, affiliate) are the
    // durable server-side record on the pending payment.
    expect(recordPendingPaymentMock).toHaveBeenCalledTimes(1);
    const pending = recordPendingPaymentMock.mock.calls[0][0] as any;
    expect(pending.metadata.transferGroup).toBe(params.metadata.transferGroup);
    expect(pending.metadata.sellerSplits).toEqual([
      {
        pubkey: SELLER_A,
        amountCents: 12500,
        accountId: "acct_any",
        donationPercent: 5,
        donationCutSmallest: 25,
        affiliateRebateSmallest: 500,
        affiliateBuyerDiscountSmallest: 0,
        affiliateAccountId: "acct_1AffiliateA",
        affiliateId: 42,
        affiliateCodeId: 7,
        affiliateCode: "FRIENDOFTHEFARM",
      },
      {
        pubkey: SELLER_B,
        amountCents: 8900,
        accountId: "acct_any",
        donationPercent: 5,
        donationCutSmallest: 25,
        affiliateRebateSmallest: 0,
        affiliateBuyerDiscountSmallest: 0,
        affiliateAccountId: null,
        affiliateId: null,
        affiliateCodeId: null,
        affiliateCode: null,
      },
    ]);
  });
  it("omits the oversized pubkey list for huge carts AND strips attacker-injected membership keys (fails closed)", async () => {
    // 8 sellers × 64-char pubkeys + commas = 519 chars, over the 490 budget,
    // so the trusted sellerSplitPubkeys is omitted entirely. If the route
    // didn't strip caller-supplied copies of the reserved keys first, an
    // attacker's injected list naming an unrelated seller would survive and
    // pass order-email payment verification for that seller.
    const victimSeller = "e".repeat(64);
    const res = makeRes();
    await createPaymentIntentHandler(
      {
        method: "POST",
        body: {
          amount: 0,
          currency: "usd",
          metadata: {
            sellerSplitPubkeys: victimSeller,
            sellerSplits: JSON.stringify([{ pubkey: victimSeller }]),
          },
          sellerSplits: Array.from({ length: 8 }, (_, i) => ({
            sellerPubkey: String(i).repeat(64),
            amountSmallest: 500,
            currency: "usd",
          })),
        },
      } as any,
      res as any
    );
    expect(res.statusCode).toBe(200);
    const params = stripeCreateMock.mock.calls[0][0] as any;
    // Neither the (omitted) trusted value nor the attacker's injected copies
    // may appear — verification downstream must fail closed for this cart.
    expect(params.metadata.sellerSplitPubkeys).toBeUndefined();
    expect(params.metadata.sellerSplits).toBeUndefined();
    // The full 8-seller split details are still persisted server-side.
    const pending = recordPendingPaymentMock.mock.calls[0][0] as any;
    expect(pending.metadata.sellerSplits).toHaveLength(8);
    // Nothing else exceeds the cap either.
    for (const value of Object.values(params.metadata)) {
      expect(String(value).length).toBeLessThanOrEqual(500);
    }
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

describe("POST /api/stripe/create-payment-intent — affiliate attribution is server-resolved", () => {
  const twoSellerBody = {
    amount: 0,
    currency: "usd",
    sellerSplits: [
      { sellerPubkey: SELLER_A, amountSmallest: 500, currency: "usd" },
      { sellerPubkey: SELLER_B, amountSmallest: 500, currency: "usd" },
    ],
  };

  it("derives rebate and affiliate IDs from the stored code row, ignoring forged request values", async () => {
    lookupAffiliateCodeMock.mockReset().mockResolvedValue({
      id: 42,
      affiliate_id: 7,
      seller_pubkey: SELLER_A,
      code: "FRIEND",
      rebate_type: "percent",
      rebate_value: 10,
      buyer_discount_type: "percent",
      buyer_discount_value: 0,
      currency: null,
      is_active: true,
      expiration: null,
      max_uses: null,
      times_used: 0,
      affiliate: {
        affiliate_pubkey: "a".repeat(64),
        stripe_account_id: "acct_aff",
      },
    });
    const res = makeRes();
    await createPaymentIntentHandler(
      {
        method: "POST",
        headers: { host: SITE_HOST },
        body: {
          ...twoSellerBody,
          sellerSplits: [
            {
              sellerPubkey: SELLER_A,
              amountSmallest: 500,
              currency: "usd",
              affiliateCode: "friend",
              // Forged: none of these may survive into the record.
              affiliateRebateSmallest: 499,
              affiliateId: 666,
              affiliateCodeId: 777,
              affiliateAccountId: "acct_evil",
            },
            { sellerPubkey: SELLER_B, amountSmallest: 500, currency: "usd" },
          ],
        },
      } as any,
      res as any
    );
    expect(res.statusCode).toBe(200);
    expect(lookupAffiliateCodeMock).toHaveBeenCalledWith(SELLER_A, "friend");
    const recordCall = recordPendingPaymentMock.mock.calls[0][0] as any;
    const splitA = recordCall.metadata.sellerSplits[0];
    // 10% of 500 = 50 — from the stored code config, not the forged 499.
    expect(splitA.affiliateRebateSmallest).toBe(50);
    expect(splitA.affiliateId).toBe(7);
    expect(splitA.affiliateCodeId).toBe(42);
    expect(splitA.affiliateCode).toBe("FRIEND");
    expect(splitA.affiliateAccountId).toBe("acct_aff");
    const splitB = recordCall.metadata.sellerSplits[1];
    expect(splitB.affiliateRebateSmallest).toBe(0);
    expect(splitB.affiliateId).toBeNull();
  });

  it("records no attribution when the code does not resolve for that seller", async () => {
    lookupAffiliateCodeMock.mockReset().mockResolvedValue(null);
    const res = makeRes();
    await createPaymentIntentHandler(
      {
        method: "POST",
        headers: { host: SITE_HOST },
        body: {
          ...twoSellerBody,
          sellerSplits: [
            {
              sellerPubkey: SELLER_A,
              amountSmallest: 500,
              currency: "usd",
              affiliateCode: "NOPE",
              affiliateRebateSmallest: 499,
              affiliateId: 666,
            },
            { sellerPubkey: SELLER_B, amountSmallest: 500, currency: "usd" },
          ],
        },
      } as any,
      res as any
    );
    expect(res.statusCode).toBe(200);
    const recordCall = recordPendingPaymentMock.mock.calls[0][0] as any;
    const splitA = recordCall.metadata.sellerSplits[0];
    expect(splitA.affiliateRebateSmallest).toBe(0);
    expect(splitA.affiliateId).toBeNull();
    expect(splitA.affiliateCodeId).toBeNull();
    expect(splitA.affiliateCode).toBeNull();
  });

  it("computes the rebate on the already-discounted split amount and records the discount for reporting", async () => {
    // The cart applies the buyer discount when constructing amountSmallest:
    // 10% off a 10000 gross → split 9000. The 20% rebate must be computed on
    // that 9000 (=1800), NOT on a double-discounted 8100 (=1620).
    lookupAffiliateCodeMock.mockReset().mockResolvedValue({
      id: 42,
      affiliate_id: 7,
      seller_pubkey: SELLER_A,
      code: "FRIEND",
      rebate_type: "percent",
      rebate_value: 20,
      buyer_discount_type: "percent",
      buyer_discount_value: 10,
      currency: null,
      is_active: true,
      expiration: null,
      max_uses: null,
      times_used: 0,
      affiliate: { affiliate_pubkey: "a".repeat(64), stripe_account_id: null },
    });
    const res = makeRes();
    await createPaymentIntentHandler(
      {
        method: "POST",
        headers: { host: SITE_HOST },
        body: {
          amount: 0,
          currency: "usd",
          sellerSplits: [
            {
              sellerPubkey: SELLER_A,
              amountSmallest: 9000,
              currency: "usd",
              affiliateCode: "FRIEND",
            },
            { sellerPubkey: SELLER_B, amountSmallest: 500, currency: "usd" },
          ],
        },
      } as any,
      res as any
    );
    expect(res.statusCode).toBe(200);
    const recordCall = recordPendingPaymentMock.mock.calls[0][0] as any;
    const splitA = recordCall.metadata.sellerSplits[0];
    expect(splitA.affiliateRebateSmallest).toBe(1800);
    // Reconstructed for referral reporting: gross 10000 − net 9000.
    expect(splitA.affiliateBuyerDiscountSmallest).toBe(1000);
  });

  it("rejects a split set with a duplicate seller pubkey", async () => {
    // Payout claims key on (paymentIntentId, sellerPubkey): a duplicated
    // seller would pay once and misreport the rest while the buyer is
    // charged the full sum.
    const res = makeRes();
    await createPaymentIntentHandler(
      {
        method: "POST",
        headers: { host: SITE_HOST },
        body: {
          amount: 0,
          currency: "usd",
          sellerSplits: [
            { sellerPubkey: SELLER_A, amountSmallest: 500, currency: "usd" },
            { sellerPubkey: SELLER_A, amountSmallest: 700, currency: "usd" },
          ],
        },
      } as any,
      res as any
    );
    expect(res.statusCode).toBe(400);
    expect((res.body as any).error).toMatch(/duplicate seller/i);
    expect(stripeCreateMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/stripe/create-payment-intent — split record persistence fails closed", () => {
  const twoSellerBody = {
    amount: 0,
    currency: "usd",
    sellerSplits: [
      { sellerPubkey: SELLER_A, amountSmallest: 500, currency: "usd" },
      { sellerPubkey: SELLER_B, amountSmallest: 500, currency: "usd" },
    ],
  };

  it("stamps the server-owned split authority marker into the PaymentIntent metadata", async () => {
    const res = makeRes();
    await createPaymentIntentHandler(
      { method: "POST", body: twoSellerBody } as any,
      res as any
    );
    expect(res.statusCode).toBe(200);
    const params = stripeCreateMock.mock.calls[0][0] as any;
    expect(params.metadata.ssSplitAuthority).toBe("pending-record-v1");
  });

  it("refuses checkout when the authoritative split record cannot be saved", async () => {
    // process-transfers pays out from this record, so a checkout without it
    // must never become payable — fail before the PaymentIntent is created.
    recordPendingPaymentMock.mockRejectedValue(new Error("db down"));
    const res = makeRes();
    await createPaymentIntentHandler(
      { method: "POST", body: twoSellerBody } as any,
      res as any
    );
    expect(res.statusCode).toBe(500);
    expect((res.body as any).clientSecret).toBeUndefined();
    expect(stripeCreateMock).not.toHaveBeenCalled();
  });

  it("refuses checkout when the payment-intent binding to the record fails", async () => {
    // Without the payment_intent_id binding, process-transfers cannot find
    // the record and (correctly) fails closed — so never hand the buyer a
    // usable clientSecret for this intent.
    updatePendingPaymentMock.mockRejectedValue(new Error("db down"));
    const res = makeRes();
    await createPaymentIntentHandler(
      { method: "POST", body: twoSellerBody } as any,
      res as any
    );
    expect(res.statusCode).toBe(500);
    expect((res.body as any).clientSecret).toBeUndefined();
    expect(stripeCreateMock).toHaveBeenCalledTimes(1);
  });

  it("server values always win over caller-injected authority keys", async () => {
    const res = makeRes();
    await createPaymentIntentHandler(
      {
        method: "POST",
        body: {
          ...twoSellerBody,
          metadata: {
            sellerSplits: "forged",
            transferGroup: "cart_forged",
            isMultiMerchant: "false",
            ssSplitAuthority: "forged",
            sellerSplitPubkeys: "e".repeat(64),
          },
        },
      } as any,
      res as any
    );
    expect(res.statusCode).toBe(200);
    const params = stripeCreateMock.mock.calls[0][0] as any;
    // Server-stamped values, never the injected ones.
    expect(params.metadata.isMultiMerchant).toBe("true");
    expect(params.metadata.transferGroup).toMatch(/^cart_/);
    expect(params.metadata.transferGroup).not.toBe("cart_forged");
    expect(params.metadata.ssSplitAuthority).toBe("pending-record-v1");
    expect(params.metadata.sellerSplitPubkeys).toBe(`${SELLER_A},${SELLER_B}`);
    expect(params.metadata.sellerSplits).toBeUndefined();
    // The durable record likewise carries only the server-computed splits.
    const recordCall = recordPendingPaymentMock.mock.calls[0][0] as any;
    expect(recordCall.metadata.transferGroup).toBe(
      params.metadata.transferGroup
    );
    expect(Array.isArray(recordCall.metadata.sellerSplits)).toBe(true);
    expect(recordCall.metadata.sellerSplits).toHaveLength(2);
    expect(recordCall.metadata.isMultiMerchant).toBeUndefined();
    expect(recordCall.metadata.ssSplitAuthority).toBeUndefined();
    expect(recordCall.metadata.sellerSplitPubkeys).toBeUndefined();
  });
});
