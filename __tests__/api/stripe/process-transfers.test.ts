/** @jest-environment node */

// Route-level coverage for pages/api/stripe/process-transfers.ts:
//
//   1. Server-authoritative splits — transfers are computed from the
//      pending-payment record (or, for legacy intents, the server-stamped
//      split JSON in the PaymentIntent's own metadata). The buyer's browser
//      payload is NEVER a source of truth: it is only cross-checked, and any
//      divergence fails closed.
//   2. Fail-closed anomalies — a marked/recognized multi-seller intent with a
//      missing or malformed authority payload is refused; a single-seller
//      intent is not payable here at all.
//   3. Replay safety — a durable per-(paymentIntentId, sellerPubkey) payout
//      claim prevents double transfers beyond Stripe's ~24h idempotency
//      window; the claim key is derived from the server-resolved split, so a
//      caller cannot mint new payouts by inventing seller pubkeys.

const applyRateLimitMock = jest.fn();
const getStripeConnectAccountMock = jest.fn();
const getPendingPaymentByIntentIdMock = jest.fn();
const claimPayoutMock = jest.fn();
const completePayoutClaimMock = jest.fn();
const releasePayoutClaimMock = jest.fn();
const paymentIntentRetrieveMock = jest.fn();
const transferCreateMock = jest.fn();
const transfersListMock = jest.fn();
const recordReferralMock = jest.fn();
const lookupAffiliateCodeMock = jest.fn();
const migrateReferralOrderIdMock = jest.fn();

jest.mock("stripe", () => {
  // retry-service classifies via `error instanceof Stripe.errors.X` — the
  // mock must provide real error classes or classification itself crashes
  // and masks the original error (including its `type` discriminator).
  class StripeConnectionError extends Error {}
  class StripeAPIError extends Error {}
  class StripeRateLimitError extends Error {}
  class StripeInvalidRequestError extends Error {}
  const Stripe: any = jest.fn().mockImplementation(() => ({
    paymentIntents: {
      retrieve: (...args: unknown[]) => paymentIntentRetrieveMock(...args),
    },
    transfers: {
      create: (...args: unknown[]) => transferCreateMock(...args),
      list: (...args: unknown[]) => transfersListMock(...args),
    },
  }));
  Stripe.errors = {
    StripeConnectionError,
    StripeAPIError,
    StripeRateLimitError,
    StripeInvalidRequestError,
  };
  return { __esModule: true, default: Stripe };
});

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: (...args: unknown[]) => applyRateLimitMock(...args),
}));

jest.mock("@/utils/db/db-service", () => ({
  getStripeConnectAccount: (...args: unknown[]) =>
    getStripeConnectAccountMock(...args),
}));

jest.mock("@/utils/stripe/pending-payments", () => ({
  // Keep the real authority-marker constants so this suite can't drift from
  // what create-payment-intent actually stamps.
  ...jest.requireActual("@/utils/stripe/pending-payments"),
  getPendingPaymentByIntentId: (...args: unknown[]) =>
    getPendingPaymentByIntentIdMock(...args),
}));

jest.mock("@/utils/stripe/payout-claims", () => ({
  // Re-export the REAL conflict error class so the route's instanceof check
  // sees the same constructor as tests that raise it.
  PayoutClaimConflictError: jest.requireActual("@/utils/stripe/payout-claims")
    .PayoutClaimConflictError,
  claimPayout: (...args: unknown[]) => claimPayoutMock(...args),
  completePayoutClaim: (...args: unknown[]) =>
    completePayoutClaimMock(...args),
  releasePayoutClaim: (...args: unknown[]) => releasePayoutClaimMock(...args),
}));

const { PayoutClaimConflictError } = jest.requireActual(
  "@/utils/stripe/payout-claims"
) as { PayoutClaimConflictError: new (id: string) => Error };

jest.mock("@/utils/db/affiliates", () => ({
  // Real pure helpers (rebate math, validity, self-referral); only the
  // seller-scoped DB lookup and the referral write are mocked.
  ...jest.requireActual("@/utils/db/affiliates"),
  recordReferral: (...args: unknown[]) => recordReferralMock(...args),
  lookupAffiliateCode: (...args: unknown[]) => lookupAffiliateCodeMock(...args),
  migrateReferralOrderId: (...args: unknown[]) =>
    migrateReferralOrderIdMock(...args),
}));

import handler from "@/pages/api/stripe/process-transfers";

const SELLER_A = "c".repeat(64);
const SELLER_B = "d".repeat(64);
const PLATFORM_PK = "f".repeat(64);

const RECORD_SPLITS = [
  {
    pubkey: SELLER_A,
    amountCents: 500,
    accountId: "acct_a",
    donationPercent: 0,
    donationCutSmallest: 0,
    affiliateRebateSmallest: 0,
    affiliateAccountId: null,
    affiliateId: null,
    affiliateCodeId: null,
    affiliateCode: null,
  },
  {
    pubkey: SELLER_B,
    amountCents: 700,
    accountId: "acct_b",
    donationPercent: 0,
    donationCutSmallest: 0,
    affiliateRebateSmallest: 0,
    affiliateAccountId: null,
    affiliateId: null,
    affiliateCodeId: null,
    affiliateCode: null,
  },
];

function makePendingRecord(over: Record<string, unknown> = {}) {
  const { metadata: overMetadata, ...rest } = over;
  return {
    intentRef: "mm_abc",
    paymentIntentId: "pi_123",
    amount: 1200,
    currency: "usd",
    status: "created",
    lastErrorMessage: null,
    createdAt: 1,
    updatedAt: 1,
    ...rest,
    metadata: {
      transferGroup: "cart_1_xyz",
      sellerSplits: RECORD_SPLITS,
      ...((overMetadata as Record<string, unknown>) ?? {}),
    },
  };
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

function makeReq(body: Record<string, unknown>) {
  return { method: "POST", body } as any;
}

const ORIGINAL_PK = process.env.NEXT_PUBLIC_SELF_SOWN_PK;

beforeEach(() => {
  applyRateLimitMock.mockReset().mockReturnValue(true);
  getStripeConnectAccountMock.mockReset().mockResolvedValue({
    stripe_account_id: "acct_from_db",
    charges_enabled: true,
  });
  getPendingPaymentByIntentIdMock.mockReset().mockResolvedValue(null);
  claimPayoutMock
    .mockReset()
    .mockResolvedValue({ created: true, transferId: null });
  completePayoutClaimMock.mockReset().mockResolvedValue(undefined);
  releasePayoutClaimMock.mockReset().mockResolvedValue(undefined);
  paymentIntentRetrieveMock.mockReset().mockResolvedValue({
    id: "pi_123",
    status: "succeeded",
    currency: "usd",
    amount: 1200,
    // Server-set at creation (multi-merchant branch only) — the unforgeable
    // multi-seller proof.
    transfer_group: "cart_1_xyz",
    metadata: {
      orderId: "order_1",
      ssSplitAuthority: "pending-record-v1",
    },
  });
  transferCreateMock
    .mockReset()
    .mockImplementation((params: { destination: string }) =>
      Promise.resolve({ id: `tr_${params.destination}` })
    );
  // Default: no pre-existing transfers at Stripe for this group.
  transfersListMock.mockReset().mockResolvedValue({ data: [] });
  recordReferralMock.mockReset().mockResolvedValue(undefined);
  migrateReferralOrderIdMock.mockReset().mockResolvedValue(undefined);
  // Default: any code string resolves to a valid seller-scoped code row whose
  // 20% rebate recomputes to the 100 the fixtures record — so existing tests
  // keep their shape while payout re-derives (never trusts) record values.
  lookupAffiliateCodeMock.mockReset().mockResolvedValue({
    id: 9,
    affiliate_id: 7,
    seller_pubkey: SELLER_A,
    code: "FRIEND",
    rebate_type: "percent",
    rebate_value: 20,
    buyer_discount_type: "percent",
    buyer_discount_value: 0,
    currency: null,
    is_active: true,
    expiration: null,
    max_uses: null,
    times_used: 0,
    affiliate: { affiliate_pubkey: "z".repeat(64), stripe_account_id: null },
  });
  process.env.NEXT_PUBLIC_SELF_SOWN_PK = PLATFORM_PK;
});

afterAll(() => {
  if (ORIGINAL_PK === undefined) delete process.env.NEXT_PUBLIC_SELF_SOWN_PK;
  else process.env.NEXT_PUBLIC_SELF_SOWN_PK = ORIGINAL_PK;
});

describe("POST /api/stripe/process-transfers — server-authoritative splits", () => {
  it("pays out from the pending-payment record even when no client splits are sent", async () => {
    getPendingPaymentByIntentIdMock.mockResolvedValue(makePendingRecord());
    const res = makeRes();
    await handler(
      makeReq({ paymentIntentId: "pi_123", transferGroup: "cart_1_xyz" }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as any).success).toBe(true);
    expect(transferCreateMock).toHaveBeenCalledTimes(2);
    const amounts = transferCreateMock.mock.calls
      .map((c) => (c[0] as any).amount)
      .sort();
    expect(amounts).toEqual([500, 700]);
    // Transfers are stamped with the record's transfer group.
    for (const call of transferCreateMock.mock.calls) {
      expect((call[0] as any).transfer_group).toBe("cart_1_xyz");
    }
  });

  it("ignores a forged client destination account — transfers go to the recorded accounts", async () => {
    getPendingPaymentByIntentIdMock.mockResolvedValue(makePendingRecord());
    const res = makeRes();
    await handler(
      makeReq({
        paymentIntentId: "pi_123",
        transferGroup: "cart_1_xyz",
        // Client payload matches pubkeys+amounts (so the cross-check passes)
        // but tries to reroute the destination to an attacker's account.
        sellerSplits: [
          { pubkey: SELLER_A, amountCents: 500, accountId: "acct_evil" },
          { pubkey: SELLER_B, amountCents: 700, accountId: "acct_evil" },
        ],
      }),
      res
    );
    expect(res.statusCode).toBe(200);
    const destinations = transferCreateMock.mock.calls
      .map((c) => (c[0] as any).destination)
      .sort();
    expect(destinations).toEqual(["acct_a", "acct_b"]);
  });

  it("fails closed when the client payload inflates a seller's amount", async () => {
    getPendingPaymentByIntentIdMock.mockResolvedValue(makePendingRecord());
    const res = makeRes();
    await handler(
      makeReq({
        paymentIntentId: "pi_123",
        transferGroup: "cart_1_xyz",
        sellerSplits: [
          // Tampered: SELLER_A's gross jumped from 500 to 50000.
          { pubkey: SELLER_A, amountCents: 50000, accountId: "acct_a" },
          { pubkey: SELLER_B, amountCents: 700, accountId: "acct_b" },
        ],
      }),
      res
    );
    expect(res.statusCode).toBe(400);
    expect((res.body as any).error).toMatch(/do not match/i);
    expect(transferCreateMock).not.toHaveBeenCalled();
  });

  it("fails closed when the client payload swaps in a different seller", async () => {
    getPendingPaymentByIntentIdMock.mockResolvedValue(makePendingRecord());
    const res = makeRes();
    await handler(
      makeReq({
        paymentIntentId: "pi_123",
        transferGroup: "cart_1_xyz",
        sellerSplits: [
          { pubkey: SELLER_A, amountCents: 500, accountId: "acct_a" },
          // Attacker's own pubkey in place of SELLER_B.
          { pubkey: "e".repeat(64), amountCents: 700, accountId: "acct_evil" },
        ],
      }),
      res
    );
    expect(res.statusCode).toBe(400);
    expect(transferCreateMock).not.toHaveBeenCalled();
  });

  it("fails closed when the transferGroup does not match the record", async () => {
    getPendingPaymentByIntentIdMock.mockResolvedValue(makePendingRecord());
    const res = makeRes();
    await handler(
      makeReq({
        paymentIntentId: "pi_123",
        transferGroup: "cart_1_FORGED",
        sellerSplits: RECORD_SPLITS.map((s) => ({
          pubkey: s.pubkey,
          amountCents: s.amountCents,
          accountId: s.accountId,
        })),
      }),
      res
    );
    expect(res.statusCode).toBe(400);
    expect((res.body as any).error).toMatch(/transferGroup/);
    expect(transferCreateMock).not.toHaveBeenCalled();
  });

  it("accepts a client payload that matches the record exactly", async () => {
    getPendingPaymentByIntentIdMock.mockResolvedValue(makePendingRecord());
    const res = makeRes();
    await handler(
      makeReq({
        paymentIntentId: "pi_123",
        transferGroup: "cart_1_xyz",
        sellerSplits: RECORD_SPLITS.map((s) => ({
          pubkey: s.pubkey,
          amountCents: s.amountCents,
          accountId: s.accountId,
        })),
      }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as any).success).toBe(true);
    expect(transferCreateMock).toHaveBeenCalledTimes(2);
  });

  it("uses the record's donation cut and affiliate rebate, not the client's", async () => {
    getPendingPaymentByIntentIdMock.mockResolvedValue(
      makePendingRecord({
        metadata: {
          sellerSplits: [
            {
              ...RECORD_SPLITS[0],
              donationPercent: 10,
              donationCutSmallest: 50,
              affiliateRebateSmallest: 100,
              affiliateBuyerDiscountSmallest: 200,
              affiliateId: 7,
              affiliateCodeId: 9,
              affiliateCode: "FRIEND",
            },
            RECORD_SPLITS[1],
          ],
        },
      })
    );
    const res = makeRes();
    await handler(
      makeReq({ paymentIntentId: "pi_123", transferGroup: "cart_1_xyz" }),
      res
    );
    expect(res.statusCode).toBe(200);
    // SELLER_A: 500 - 50 donation - 100 rebate = 350 transferred.
    const callA = transferCreateMock.mock.calls.find(
      (c) => (c[0] as any).destination === "acct_a"
    );
    expect((callA![0] as any).amount).toBe(350);
    // The rebate accrued server-side against the RESOLVED affiliate ids.
    // Gross/discount are reconstructed from the code config at payout (the
    // default mock code grants no buyer discount) — the record's
    // affiliateBuyerDiscountSmallest: 200 is reporting-only and untrusted.
    expect(recordReferralMock).toHaveBeenCalledWith(
      expect.objectContaining({
        affiliateId: 7,
        codeId: 9,
        sellerPubkey: SELLER_A,
        rebateSmallest: 100,
        paymentRail: "stripe",
        grossSubtotalSmallest: 500,
        buyerDiscountSmallest: 0,
        orderId: "pi_123",
      })
    );
  });
});

describe("POST /api/stripe/process-transfers — payout claim replay safety", () => {
  it("claims each payout server-side and completes the claim with the transfer id", async () => {
    getPendingPaymentByIntentIdMock.mockResolvedValue(makePendingRecord());
    const res = makeRes();
    await handler(
      makeReq({ paymentIntentId: "pi_123", transferGroup: "cart_1_xyz" }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(claimPayoutMock).toHaveBeenCalledWith("pi_123", SELLER_A);
    expect(claimPayoutMock).toHaveBeenCalledWith("pi_123", SELLER_B);
    expect(completePayoutClaimMock).toHaveBeenCalledWith(
      "pi_123",
      SELLER_A,
      "tr_acct_a"
    );
    expect(completePayoutClaimMock).toHaveBeenCalledWith(
      "pi_123",
      SELLER_B,
      "tr_acct_b"
    );
  });

  it("a repeated call does not create a second transfer for an already-paid seller", async () => {
    getPendingPaymentByIntentIdMock.mockResolvedValue(makePendingRecord());
    claimPayoutMock.mockResolvedValue({
      created: false,
      transferId: "tr_existing",
    });
    const res = makeRes();
    await handler(
      makeReq({ paymentIntentId: "pi_123", transferGroup: "cart_1_xyz" }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as any).success).toBe(true);
    expect(transferCreateMock).not.toHaveBeenCalled();
    const results = (res.body as any).results as any[];
    expect(results.every((r) => r.transferId === "tr_existing")).toBe(true);
  });

  it("replaying a completed claim re-attempts the idempotent affiliate accrual", async () => {
    // Claim completion and recordReferral are not transactional: a crash
    // between them leaves the rebate withheld from the seller but never
    // credited. Every replay must re-attempt the (idempotent) accrual.
    getPendingPaymentByIntentIdMock.mockResolvedValue(
      makePendingRecord({
        metadata: {
          sellerSplits: [
            {
              ...RECORD_SPLITS[0],
              affiliateRebateSmallest: 100,
              affiliateId: 7,
              affiliateCodeId: 9,
              affiliateCode: "FRIEND",
            },
            RECORD_SPLITS[1],
          ],
        },
      })
    );
    claimPayoutMock.mockResolvedValue({ created: false, transferId: "tr_x" });
    const res = makeRes();
    await handler(
      makeReq({ paymentIntentId: "pi_123", transferGroup: "cart_1_xyz" }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as any).success).toBe(true);
    expect(transferCreateMock).not.toHaveBeenCalled();
    expect(recordReferralMock).toHaveBeenCalledTimes(1);
    expect(recordReferralMock).toHaveBeenCalledWith(
      expect.objectContaining({
        affiliateId: 7,
        codeId: 9,
        sellerPubkey: SELLER_A,
        rebateSmallest: 100,
        paymentRail: "stripe",
      })
    );
  });

  it("re-resolves affiliate fields server-side, ignoring forged values in a staged legacy record", async () => {
    // A pending record written under the former browser-authoritative route
    // can carry forged rebate amounts, affiliate/code IDs, and an attacker
    // affiliate account. Payout re-derives everything from the code string
    // against the seller-scoped code row — the record's values are untrusted.
    getPendingPaymentByIntentIdMock.mockResolvedValue(
      makePendingRecord({
        metadata: {
          sellerSplits: [
            {
              ...RECORD_SPLITS[0],
              affiliateRebateSmallest: 4999, // forged: would drain the seller
              affiliateBuyerDiscountSmallest: 99999, // forged reporting
              affiliateId: 666, // forged
              affiliateCodeId: 777, // forged
              affiliateAccountId: "acct_evil", // forged
              affiliateCode: "FRIEND",
            },
            RECORD_SPLITS[1],
          ],
        },
      })
    );
    const res = makeRes();
    await handler(
      makeReq({ paymentIntentId: "pi_123", transferGroup: "cart_1_xyz" }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as any).success).toBe(true);
    const callA = transferCreateMock.mock.calls.find(
      (c) => (c[0] as any).destination === "acct_a"
    );
    // 500 − 100 recomputed rebate (20% of 500 per the stored code config),
    // NOT the forged 4999.
    expect((callA![0] as any).amount).toBe(400);
    expect(
      transferCreateMock.mock.calls.every(
        (c) => (c[0] as any).destination !== "acct_evil"
      )
    ).toBe(true);
    expect(recordReferralMock).toHaveBeenCalledWith(
      expect.objectContaining({
        affiliateId: 7, // resolved from the stored code row, not forged 666
        codeId: 9, // resolved, not forged 777
        sellerPubkey: SELLER_A,
        rebateSmallest: 100,
        grossSubtotalSmallest: 500, // forged 99999 discount ignored
        buyerDiscountSmallest: 0,
        orderId: "pi_123", // PI-bound dedup key, never client orderId
      })
    );
  });

  it("deducts no rebate and accrues nothing when the staged code no longer resolves", async () => {
    // Fail-safe direction: an unresolvable/invalid code must not short the
    // seller — no deduction, no accrual.
    lookupAffiliateCodeMock.mockResolvedValue(null);
    getPendingPaymentByIntentIdMock.mockResolvedValue(
      makePendingRecord({
        metadata: {
          sellerSplits: [
            {
              ...RECORD_SPLITS[0],
              affiliateRebateSmallest: 100,
              affiliateId: 7,
              affiliateCodeId: 9,
              affiliateCode: "FRIEND",
            },
            RECORD_SPLITS[1],
          ],
        },
      })
    );
    const res = makeRes();
    await handler(
      makeReq({ paymentIntentId: "pi_123", transferGroup: "cart_1_xyz" }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as any).success).toBe(true);
    const callA = transferCreateMock.mock.calls.find(
      (c) => (c[0] as any).destination === "acct_a"
    );
    expect((callA![0] as any).amount).toBe(500);
    expect(recordReferralMock).not.toHaveBeenCalled();
  });

  it("re-keys a legacy metadata-order referral onto the PaymentIntent id before accruing", async () => {
    // Rollout boundary: a referral recorded before the PI-id keying lives
    // under the client-supplied metadata orderId. Accrual must migrate that
    // row first so the dedup insert sees it — otherwise replaying an
    // already-paid intent (e.g. a historical-transfer adoption) creates a
    // second payable referral for the same sale.
    // Unmarked intent: created before the authority marker existed, so it
    // can genuinely carry an order-keyed referral row.
    paymentIntentRetrieveMock.mockResolvedValue({
      id: "pi_123",
      status: "succeeded",
      currency: "usd",
      amount: 1200,
      transfer_group: "cart_1_xyz",
      metadata: { orderId: "order_1" },
    });
    getPendingPaymentByIntentIdMock.mockResolvedValue(
      makePendingRecord({
        metadata: {
          sellerSplits: [
            {
              ...RECORD_SPLITS[0],
              affiliateRebateSmallest: 100,
              affiliateId: 7,
              affiliateCodeId: 9,
              affiliateCode: "FRIEND",
            },
            RECORD_SPLITS[1],
          ],
        },
      })
    );
    const res = makeRes();
    await handler(
      makeReq({ paymentIntentId: "pi_123", transferGroup: "cart_1_xyz" }),
      res
    );
    expect(res.statusCode).toBe(200);
    // The default PI metadata carries the legacy client-supplied order id.
    expect(migrateReferralOrderIdMock).toHaveBeenCalledWith({
      legacyOrderId: "order_1",
      newOrderId: "pi_123",
      codeId: 9,
      sellerPubkey: SELLER_A,
    });
    // And the accrual lands under the canonical PI id, where the migrated
    // row now dedups it.
    expect(recordReferralMock).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "pi_123", codeId: 9 })
    );
  });

  it("skips the legacy-key migration when the intent carries no metadata order id", async () => {
    paymentIntentRetrieveMock.mockResolvedValue({
      id: "pi_123",
      status: "succeeded",
      currency: "usd",
      amount: 1200,
      transfer_group: "cart_1_xyz",
      metadata: { ssSplitAuthority: "pending-record-v1" },
    });
    getPendingPaymentByIntentIdMock.mockResolvedValue(
      makePendingRecord({
        metadata: {
          sellerSplits: [
            {
              ...RECORD_SPLITS[0],
              affiliateRebateSmallest: 100,
              affiliateId: 7,
              affiliateCodeId: 9,
              affiliateCode: "FRIEND",
            },
            RECORD_SPLITS[1],
          ],
        },
      })
    );
    const res = makeRes();
    await handler(
      makeReq({ paymentIntentId: "pi_123", transferGroup: "cart_1_xyz" }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(migrateReferralOrderIdMock).not.toHaveBeenCalled();
    expect(recordReferralMock).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "pi_123" })
    );
  });

  it("never re-keys referrals for a current intent, even with a colliding metadata order id", async () => {
    // metadata.orderId stays caller-influenceable. On a MARKED (current)
    // intent no order-keyed referral rows can exist, so a forged value
    // naming ANOTHER order must not re-key its referral onto this PI.
    paymentIntentRetrieveMock.mockResolvedValue({
      id: "pi_123",
      status: "succeeded",
      currency: "usd",
      amount: 1200,
      transfer_group: "cart_1_xyz",
      metadata: {
        orderId: "order_victim",
        ssSplitAuthority: "pending-record-v1",
      },
    });
    getPendingPaymentByIntentIdMock.mockResolvedValue(
      makePendingRecord({
        metadata: {
          sellerSplits: [
            {
              ...RECORD_SPLITS[0],
              affiliateRebateSmallest: 100,
              affiliateId: 7,
              affiliateCodeId: 9,
              affiliateCode: "FRIEND",
            },
            RECORD_SPLITS[1],
          ],
        },
      })
    );
    const res = makeRes();
    await handler(
      makeReq({ paymentIntentId: "pi_123", transferGroup: "cart_1_xyz" }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(migrateReferralOrderIdMock).not.toHaveBeenCalled();
    expect(recordReferralMock).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "pi_123", codeId: 9 })
    );
  });

  it("converts fixed rebates with the charge currency's minor-unit scale (JPY)", async () => {
    // Zero-decimal currency: a ¥50 fixed rebate is 50 smallest units, not
    // 5000 — a x100 conversion would hand nearly the whole split to the
    // affiliate and leave the seller a single yen.
    lookupAffiliateCodeMock.mockResolvedValue({
      id: 9,
      affiliate_id: 7,
      seller_pubkey: SELLER_A,
      code: "FIXED50",
      rebate_type: "fixed",
      rebate_value: 50,
      buyer_discount_type: null,
      buyer_discount_value: 0,
      currency: "jpy",
      is_active: true,
      expiration: null,
      max_uses: null,
      times_used: 0,
      affiliate: { affiliate_pubkey: "z".repeat(64), stripe_account_id: null },
    });
    getPendingPaymentByIntentIdMock.mockResolvedValue(
      makePendingRecord({
        amount: 10000,
        currency: "jpy",
        metadata: {
          sellerSplits: [
            {
              ...RECORD_SPLITS[0],
              amountCents: 10000,
              affiliateCode: "FIXED50",
            },
          ],
        },
      })
    );
    paymentIntentRetrieveMock.mockResolvedValue({
      id: "pi_123",
      status: "succeeded",
      currency: "jpy",
      amount: 10000,
      transfer_group: "cart_1_xyz",
      metadata: { ssSplitAuthority: "pending-record-v1" },
    });
    const res = makeRes();
    await handler(
      makeReq({ paymentIntentId: "pi_123", transferGroup: "cart_1_xyz" }),
      res
    );
    expect(res.statusCode).toBe(200);
    const call = transferCreateMock.mock.calls.find(
      (c) => (c[0] as any).destination === "acct_a"
    );
    expect((call![0] as any).amount).toBe(10000 - 50);
    expect(recordReferralMock).toHaveBeenCalledWith(
      expect.objectContaining({ rebateSmallest: 50, currency: "jpy" })
    );
  });

  it("an unresolved claim (crash after transfer, before completion) blocks replay instead of double-paying", async () => {
    getPendingPaymentByIntentIdMock.mockResolvedValue(makePendingRecord());
    // Claim exists but no transfer id was ever recorded — a previous attempt
    // may have completed at Stripe. Beyond Stripe's ~24h idempotency window
    // a retry would double-pay, so this must fail closed for reconciliation.
    claimPayoutMock.mockResolvedValue({ created: false, transferId: null });
    const res = makeRes();
    await handler(
      makeReq({ paymentIntentId: "pi_123", transferGroup: "cart_1_xyz" }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as any).success).toBe(false);
    expect(transferCreateMock).not.toHaveBeenCalled();
    const results = (res.body as any).results as any[];
    expect(results.every((r) => /reconciliation/i.test(r.error ?? ""))).toBe(
      true
    );
  });

  it("releases the claim when Stripe conclusively rejects the transfer so a retry can pay", async () => {
    getPendingPaymentByIntentIdMock.mockResolvedValue(makePendingRecord());
    // Invalid-request errors mean Stripe never created a transfer.
    const err = Object.assign(new Error("insufficient balance"), {
      type: "StripeInvalidRequestError",
    });
    transferCreateMock.mockRejectedValue(err);
    const res = makeRes();
    await handler(
      makeReq({ paymentIntentId: "pi_123", transferGroup: "cart_1_xyz" }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as any).success).toBe(false);
    expect(releasePayoutClaimMock).toHaveBeenCalledWith("pi_123", SELLER_A);
    expect(releasePayoutClaimMock).toHaveBeenCalledWith("pi_123", SELLER_B);
  });

  it("keeps the claim on an ambiguous failure (timeout/5xx) so a replay cannot double-pay", async () => {
    getPendingPaymentByIntentIdMock.mockResolvedValue(makePendingRecord());
    // A lost response is indeterminate: Stripe may have created the
    // transfer. The claim must stay unresolved, blocking naive replays.
    transferCreateMock.mockRejectedValue(new Error("socket hangup"));
    const res = makeRes();
    await handler(
      makeReq({ paymentIntentId: "pi_123", transferGroup: "cart_1_xyz" }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as any).success).toBe(false);
    expect(releasePayoutClaimMock).not.toHaveBeenCalled();
  });

  it("adopts a pre-existing Stripe transfer instead of double-paying a historical intent", async () => {
    // This intent was paid out BEFORE payout claims existed: fresh claims
    // are created, but Stripe already holds the transfers. The route must
    // adopt them into the claims and never create new ones.
    getPendingPaymentByIntentIdMock.mockResolvedValue(makePendingRecord());
    transfersListMock.mockResolvedValue({
      data: [
        {
          id: "tr_old_a",
          metadata: { paymentIntentId: "pi_123", sellerPubkey: SELLER_A },
          destination: "acct_a",
          amount: 500,
          currency: "usd",
        },
        {
          id: "tr_old_b",
          metadata: { paymentIntentId: "pi_123", sellerPubkey: SELLER_B },
          destination: "acct_b",
          amount: 700,
          currency: "usd",
        },
      ],
    });
    const res = makeRes();
    await handler(
      makeReq({ paymentIntentId: "pi_123", transferGroup: "cart_1_xyz" }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as any).success).toBe(true);
    expect(transferCreateMock).not.toHaveBeenCalled();
    expect(completePayoutClaimMock).toHaveBeenCalledWith(
      "pi_123",
      SELLER_A,
      "tr_old_a"
    );
    expect(completePayoutClaimMock).toHaveBeenCalledWith(
      "pi_123",
      SELLER_B,
      "tr_old_b"
    );
    const results = (res.body as any).results as any[];
    expect(results.map((r) => r.transferId).sort()).toEqual([
      "tr_old_a",
      "tr_old_b",
    ]);
    // The Stripe lookup is scoped to the intent's own transfer group.
    expect(transfersListMock).toHaveBeenCalledWith(
      expect.objectContaining({ transfer_group: "cart_1_xyz" })
    );
  });

  it("adopts a pre-existing transfer via destination+amount when metadata is missing", async () => {
    getPendingPaymentByIntentIdMock.mockResolvedValue(makePendingRecord());
    transfersListMock.mockResolvedValue({
      data: [
        // No metadata (very old transfer shape) — matched by destination,
        // amount and currency instead.
        { id: "tr_legacy_a", destination: "acct_a", amount: 500, currency: "usd" },
        { id: "tr_legacy_b", destination: "acct_b", amount: 700, currency: "usd" },
      ],
    });
    const res = makeRes();
    await handler(
      makeReq({ paymentIntentId: "pi_123", transferGroup: "cart_1_xyz" }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as any).success).toBe(true);
    expect(transferCreateMock).not.toHaveBeenCalled();
    expect(completePayoutClaimMock).toHaveBeenCalledWith(
      "pi_123",
      SELLER_A,
      "tr_legacy_a"
    );
  });

  it("does not adopt an unrelated transfer from the same group", async () => {
    getPendingPaymentByIntentIdMock.mockResolvedValue(makePendingRecord());
    transfersListMock.mockResolvedValue({
      data: [
        // Different destination AND amount: belongs to neither split.
        { id: "tr_other", destination: "acct_x", amount: 999, currency: "usd" },
      ],
    });
    const res = makeRes();
    await handler(
      makeReq({ paymentIntentId: "pi_123", transferGroup: "cart_1_xyz" }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(transferCreateMock).toHaveBeenCalledTimes(2);
  });

  it("adoption is one-to-one: two equal splits sharing a destination need two transfers", async () => {
    // Two sellers can legitimately map to the SAME Standard Connect account
    // with equal amounts. If only one historical transfer exists, adopting
    // it for both would mark an unpaid seller as paid — the second split
    // must create its own transfer.
    getPendingPaymentByIntentIdMock.mockResolvedValue(
      makePendingRecord({
        metadata: {
          sellerSplits: [
            { ...RECORD_SPLITS[0], amountCents: 500, accountId: "acct_shared" },
            { ...RECORD_SPLITS[1], amountCents: 500, accountId: "acct_shared" },
          ],
        },
      })
    );
    transfersListMock.mockResolvedValue({
      data: [
        // Metadata-less legacy transfer: settles exactly one of the splits.
        { id: "tr_one", destination: "acct_shared", amount: 500, currency: "usd" },
      ],
    });
    const res = makeRes();
    await handler(
      makeReq({ paymentIntentId: "pi_123", transferGroup: "cart_1_xyz" }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as any).success).toBe(true);
    // Exactly one split adopted the historical transfer...
    expect(completePayoutClaimMock).toHaveBeenCalledWith(
      "pi_123",
      SELLER_A,
      "tr_one"
    );
    // ...and the other created its own transfer (claim completed with the
    // new transfer id), for exactly two completions total — never both
    // splits claiming the same tr_one.
    expect(transferCreateMock).toHaveBeenCalledTimes(1);
    expect((transferCreateMock.mock.calls[0][0] as any).amount).toBe(500);
    expect(completePayoutClaimMock).toHaveBeenCalledWith(
      "pi_123",
      SELLER_B,
      "tr_acct_shared"
    );
    expect(completePayoutClaimMock).toHaveBeenCalledTimes(2);
    const results = (res.body as any).results as any[];
    expect(results.filter((r) => r.skipped)).toHaveLength(1);
    expect(results.filter((r) => !r.skipped && r.transferId)).toHaveLength(1);
  });

  it("fails closed on an identity-bearing transfer whose shape contradicts the authoritative split", async () => {
    getPendingPaymentByIntentIdMock.mockResolvedValue(makePendingRecord());
    transfersListMock.mockResolvedValue({
      data: [
        // Names SELLER_B for this payment, but destination and amount belong
        // to SELLER_A's split — a tampering anomaly from the pre-hardening
        // browser-authoritative route. It must NOT be recorded as SELLER_B's
        // payout, and SELLER_A must not shape-match it either.
        {
          id: "tr_b",
          metadata: { paymentIntentId: "pi_123", sellerPubkey: SELLER_B },
          destination: "acct_a",
          amount: 500,
          currency: "usd",
        },
      ],
      has_more: false,
    });
    const res = makeRes();
    await handler(
      makeReq({ paymentIntentId: "pi_123", transferGroup: "cart_1_xyz" }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as any).success).toBe(false);
    const results = (res.body as any).results as any[];
    // SELLER_B fails closed for reconciliation; tr_b is recorded nowhere.
    const bResult = results.find((r) => r.sellerPubkey === SELLER_B);
    expect(bResult.error).toMatch(/conflicting historical transfer/i);
    expect(completePayoutClaimMock).not.toHaveBeenCalledWith(
      "pi_123",
      expect.anything(),
      "tr_b"
    );
    // SELLER_A still pays out normally with its own fresh transfer.
    expect(transferCreateMock).toHaveBeenCalledTimes(1);
    expect((transferCreateMock.mock.calls[0][0] as any).destination).toBe(
      "acct_a"
    );
  });

  it("a transfer id already recorded on another claim is never re-adopted — the unpaid seller gets a distinct transfer", async () => {
    // Cross-request replay: request 1 adopted the metadata-less legacy
    // transfer tr_one for SELLER_A. This is request 2: SELLER_A's claim is
    // already completed (skipped), SELLER_B gets a fresh claim — but the
    // Stripe list still contains tr_one, which shape-matches SELLER_B's
    // split (shared destination, equal amount). The atomic reservation
    // (unique transfer_id) rejects the re-adoption and SELLER_B must get
    // its OWN transfer, not be marked paid with SELLER_A's tr_one.
    getPendingPaymentByIntentIdMock.mockResolvedValue(
      makePendingRecord({
        metadata: {
          sellerSplits: [
            { ...RECORD_SPLITS[0], amountCents: 500, accountId: "acct_shared" },
            { ...RECORD_SPLITS[1], amountCents: 500, accountId: "acct_shared" },
          ],
        },
      })
    );
    claimPayoutMock.mockImplementation((_pi: string, seller: string) =>
      seller === SELLER_A
        ? Promise.resolve({ created: false, transferId: "tr_one" })
        : Promise.resolve({ created: true, transferId: null })
    );
    completePayoutClaimMock.mockImplementation(
      (_pi: string, _seller: string, transferId: string) =>
        transferId === "tr_one"
          ? Promise.reject(new PayoutClaimConflictError("tr_one"))
          : Promise.resolve()
    );
    transfersListMock.mockResolvedValue({
      data: [
        { id: "tr_one", destination: "acct_shared", amount: 500, currency: "usd" },
      ],
      has_more: false,
    });
    const res = makeRes();
    await handler(
      makeReq({ paymentIntentId: "pi_123", transferGroup: "cart_1_xyz" }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as any).success).toBe(true);
    // SELLER_B was NOT settled with the already-owned tr_one...
    const results = (res.body as any).results as any[];
    const bResult = results.find((r) => r.sellerPubkey === SELLER_B);
    expect(bResult.transferId).not.toBe("tr_one");
    // ...it received a distinct, freshly created transfer.
    expect(transferCreateMock).toHaveBeenCalledTimes(1);
    expect((transferCreateMock.mock.calls[0][0] as any).destination).toBe(
      "acct_shared"
    );
    expect(bResult.transferId).toBe("tr_acct_shared");
  });

  it("a reservation conflict moves to the next matching candidate instead of duplicating", async () => {
    // Two equal splits share one destination; TWO metadata-less legacy
    // transfers exist. A concurrent/partial reconciliation already owns
    // tr_one — this request must adopt tr_two, not create a third payout.
    getPendingPaymentByIntentIdMock.mockResolvedValue(
      makePendingRecord({
        metadata: {
          sellerSplits: [
            { ...RECORD_SPLITS[0], amountCents: 500, accountId: "acct_shared" },
            { ...RECORD_SPLITS[1], amountCents: 500, accountId: "acct_shared" },
          ],
        },
      })
    );
    transfersListMock.mockResolvedValue({
      data: [
        { id: "tr_one", destination: "acct_shared", amount: 500, currency: "usd" },
        { id: "tr_two", destination: "acct_shared", amount: 500, currency: "usd" },
      ],
      has_more: false,
    });
    completePayoutClaimMock.mockImplementation(
      (_pi: string, _seller: string, transferId: string) =>
        transferId === "tr_one"
          ? Promise.reject(new PayoutClaimConflictError("tr_one"))
          : Promise.resolve()
    );
    const res = makeRes();
    await handler(
      makeReq({ paymentIntentId: "pi_123", transferGroup: "cart_1_xyz" }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as any).success).toBe(true);
    // SELLER_A adopted tr_two after the tr_one conflict; SELLER_B got the
    // one fresh transfer (both historical transfers were consumed).
    expect(completePayoutClaimMock).toHaveBeenCalledWith(
      "pi_123",
      SELLER_A,
      "tr_two"
    );
    expect(transferCreateMock).toHaveBeenCalledTimes(1);
    const results = (res.body as any).results as any[];
    expect(results.map((r) => r.transferId).sort()).toEqual([
      "tr_acct_shared",
      "tr_two",
    ]);
  });

  it("fails closed when the transfer-group history exceeds the reconciliation page cap", async () => {
    getPendingPaymentByIntentIdMock.mockResolvedValue(makePendingRecord());
    // Every page claims more history exists — the route must treat the view
    // as incomplete and refuse to pay rather than decide from a partial list.
    transfersListMock.mockResolvedValue({
      data: [{ id: "tr_x", destination: "acct_x", amount: 1, currency: "usd" }],
      has_more: true,
    });
    const res = makeRes();
    await handler(
      makeReq({ paymentIntentId: "pi_123", transferGroup: "cart_1_xyz" }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as any).success).toBe(false);
    expect(transferCreateMock).not.toHaveBeenCalled();
    // No transfer was attempted, so the fresh claims are released for retry.
    expect(releasePayoutClaimMock).toHaveBeenCalledWith("pi_123", SELLER_A);
    expect(releasePayoutClaimMock).toHaveBeenCalledWith("pi_123", SELLER_B);
    const results = (res.body as any).results as any[];
    expect(results.every((r) => /reconciliation/i.test(r.error ?? ""))).toBe(
      true
    );
  });

  it("fails closed when the group history contains an identity transfer naming an unknown seller", async () => {
    // A transfer naming this payment but a seller outside the authoritative
    // split set is the exact shape of a payout made through the former
    // forged-browser-payload hole. Paying the authoritative splits on top of
    // it would push total transfers past the charge.
    getPendingPaymentByIntentIdMock.mockResolvedValue(makePendingRecord());
    transfersListMock.mockResolvedValue({
      data: [
        {
          id: "tr_forged",
          metadata: {
            paymentIntentId: "pi_123",
            sellerPubkey: "e".repeat(64),
          },
          destination: "acct_evil",
          amount: 500,
          currency: "usd",
        },
      ],
      has_more: false,
    });
    const res = makeRes();
    await handler(
      makeReq({ paymentIntentId: "pi_123", transferGroup: "cart_1_xyz" }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as any).success).toBe(false);
    expect(transferCreateMock).not.toHaveBeenCalled();
    // Nothing was paid, so the fresh claims are released for ops/retry.
    expect(releasePayoutClaimMock).toHaveBeenCalledWith("pi_123", SELLER_A);
    expect(releasePayoutClaimMock).toHaveBeenCalledWith("pi_123", SELLER_B);
    const results = (res.body as any).results as any[];
    expect(results.every((r) => /reconciliation/i.test(r.error ?? ""))).toBe(
      true
    );
  });

  it("fails closed when the authoritative record duplicates a seller", async () => {
    // Claims key on (paymentIntentId, sellerPubkey): a duplicated seller
    // would pay once and misreport the rest while the buyer was charged the
    // full split sum.
    getPendingPaymentByIntentIdMock.mockResolvedValue(
      makePendingRecord({
        metadata: {
          sellerSplits: [
            RECORD_SPLITS[0],
            { ...RECORD_SPLITS[0], amountCents: 700 },
          ],
        },
      })
    );
    const res = makeRes();
    await handler(
      makeReq({ paymentIntentId: "pi_123", transferGroup: "cart_1_xyz" }),
      res
    );
    expect(res.statusCode).toBe(409);
    expect((res.body as any).error).toMatch(/duplicate seller/i);
    expect(transferCreateMock).not.toHaveBeenCalled();
  });

  it("paginates the full transfer-group history before concluding no prior payout exists", async () => {
    getPendingPaymentByIntentIdMock.mockResolvedValue(makePendingRecord());
    transfersListMock
      .mockResolvedValueOnce({
        data: [
          { id: "tr_page1", destination: "acct_x", amount: 1, currency: "usd" },
        ],
        has_more: true,
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: "tr_old_a",
            metadata: { paymentIntentId: "pi_123", sellerPubkey: SELLER_A },
            destination: "acct_a",
            amount: 500,
            currency: "usd",
          },
          {
            id: "tr_old_b",
            metadata: { paymentIntentId: "pi_123", sellerPubkey: SELLER_B },
            destination: "acct_b",
            amount: 700,
            currency: "usd",
          },
        ],
        has_more: false,
      });
    const res = makeRes();
    await handler(
      makeReq({ paymentIntentId: "pi_123", transferGroup: "cart_1_xyz" }),
      res
    );
    expect(res.statusCode).toBe(200);
    // The historical payouts on page 2 were found and adopted — nothing new.
    expect(transferCreateMock).not.toHaveBeenCalled();
    expect(transfersListMock).toHaveBeenCalledTimes(2);
    expect(transfersListMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ starting_after: "tr_page1" })
    );
  });

  it("never releases the claim when claim completion fails after a successful transfer", async () => {
    getPendingPaymentByIntentIdMock.mockResolvedValue(makePendingRecord());
    completePayoutClaimMock.mockRejectedValue(new Error("db down"));
    const res = makeRes();
    await handler(
      makeReq({ paymentIntentId: "pi_123", transferGroup: "cart_1_xyz" }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as any).success).toBe(true);
    expect(transferCreateMock).toHaveBeenCalledTimes(2);
    expect(releasePayoutClaimMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/stripe/process-transfers — fail-closed anomalies", () => {
  it("fails closed when a marked intent has no pending-payment record", async () => {
    // The PI carries the server-owned authority marker (created WITH split
    // persistence) but the record is gone — e.g. the binding write failed.
    // The browser payload must never substitute for the record here.
    getPendingPaymentByIntentIdMock.mockResolvedValue(null);
    const res = makeRes();
    await handler(
      makeReq({
        paymentIntentId: "pi_123",
        transferGroup: "cart_1_xyz",
        sellerSplits: [
          {
            pubkey: "e".repeat(64),
            amountCents: 100000,
            accountId: "acct_evil",
          },
        ],
      }),
      res
    );
    expect(res.statusCode).toBe(409);
    expect((res.body as any).error).toMatch(/split record is missing/i);
    expect(transferCreateMock).not.toHaveBeenCalled();
  });

  it("fails closed when the stored record is malformed (unusable split entry)", async () => {
    getPendingPaymentByIntentIdMock.mockResolvedValue(
      makePendingRecord({
        metadata: {
          sellerSplits: [
            RECORD_SPLITS[0],
            // Corrupt entry: no pubkey, no usable amount.
            { accountId: "acct_b" },
          ],
        },
      })
    );
    const res = makeRes();
    await handler(
      makeReq({ paymentIntentId: "pi_123", transferGroup: "cart_1_xyz" }),
      res
    );
    expect(res.statusCode).toBe(409);
    expect((res.body as any).error).toMatch(/malformed/i);
    expect(transferCreateMock).not.toHaveBeenCalled();
  });

  it("fails closed when a marked intent's record exists but carries no splits", async () => {
    getPendingPaymentByIntentIdMock.mockResolvedValue(
      makePendingRecord({ metadata: { sellerSplits: null } })
    );
    const res = makeRes();
    await handler(
      makeReq({
        paymentIntentId: "pi_123",
        transferGroup: "cart_1_xyz",
        sellerSplits: [
          { pubkey: SELLER_A, amountCents: 500, accountId: "acct_a" },
        ],
      }),
      res
    );
    expect(res.statusCode).toBe(409);
    expect(transferCreateMock).not.toHaveBeenCalled();
  });

  it("rejects a single-seller (unrecognized) payment intent even with a valid-looking payload", async () => {
    // Single-seller PIs carry no multi-merchant markers — they were never
    // payable through this route and a browser payload must not change that.
    getPendingPaymentByIntentIdMock.mockResolvedValue(null);
    paymentIntentRetrieveMock.mockResolvedValue({
      id: "pi_single",
      status: "succeeded",
      currency: "usd",
      amount: 1000,
      metadata: { orderId: "order_1" },
    });
    const res = makeRes();
    await handler(
      makeReq({
        paymentIntentId: "pi_single",
        transferGroup: "cart_forged",
        sellerSplits: [
          {
            sellerPubkey: "e".repeat(64),
            amountCents: 900,
            accountId: "acct_evil",
          },
        ],
      }),
      res
    );
    expect(res.statusCode).toBe(400);
    expect((res.body as any).error).toMatch(/not a multi-seller/i);
    expect(transferCreateMock).not.toHaveBeenCalled();
  });

  it("refuses a forged pending record planted on a single-seller payment", async () => {
    // Attacker pays a small single-seller charge with client metadata
    // containing forged sellerSplits; even if that lands in a pending row,
    // the PI has no server-set transfer_group so it can never pay out here.
    getPendingPaymentByIntentIdMock.mockResolvedValue(
      makePendingRecord({
        paymentIntentId: "pi_single",
        amount: 100,
        metadata: {
          transferGroup: "cart_forged",
          sellerSplits: [
            {
              pubkey: "e".repeat(64),
              amountCents: 100000,
              accountId: "acct_evil",
            },
          ],
        },
      })
    );
    paymentIntentRetrieveMock.mockResolvedValue({
      id: "pi_single",
      status: "succeeded",
      currency: "usd",
      amount: 100,
      metadata: { orderId: "order_1" },
    });
    const res = makeRes();
    await handler(
      makeReq({
        paymentIntentId: "pi_single",
        transferGroup: "cart_forged",
      }),
      res
    );
    expect(res.statusCode).toBe(400);
    expect((res.body as any).error).toMatch(/not a multi-seller/i);
    expect(transferCreateMock).not.toHaveBeenCalled();
  });

  it("refuses a record whose transfer group does not match the payment intent", async () => {
    getPendingPaymentByIntentIdMock.mockResolvedValue(
      makePendingRecord({ metadata: { transferGroup: "cart_OTHER" } })
    );
    const res = makeRes();
    await handler(
      makeReq({ paymentIntentId: "pi_123", transferGroup: "cart_1_xyz" }),
      res
    );
    expect(res.statusCode).toBe(409);
    expect((res.body as any).error).toMatch(/transfer group/i);
    expect(transferCreateMock).not.toHaveBeenCalled();
  });

  it("refuses a record whose currency does not match the payment intent", async () => {
    getPendingPaymentByIntentIdMock.mockResolvedValue(
      makePendingRecord({ currency: "eur" })
    );
    const res = makeRes();
    await handler(
      makeReq({ paymentIntentId: "pi_123", transferGroup: "cart_1_xyz" }),
      res
    );
    expect(res.statusCode).toBe(409);
    expect((res.body as any).error).toMatch(/currency/i);
    expect(transferCreateMock).not.toHaveBeenCalled();
  });

  it("refuses a record whose split total exceeds the amount paid", async () => {
    getPendingPaymentByIntentIdMock.mockResolvedValue(makePendingRecord());
    // Buyer only paid 600 but the record claims 500 + 700.
    paymentIntentRetrieveMock.mockResolvedValue({
      id: "pi_123",
      status: "succeeded",
      currency: "usd",
      amount: 600,
      transfer_group: "cart_1_xyz",
      metadata: { ssSplitAuthority: "pending-record-v1" },
    });
    const res = makeRes();
    await handler(
      makeReq({ paymentIntentId: "pi_123", transferGroup: "cart_1_xyz" }),
      res
    );
    expect(res.statusCode).toBe(409);
    expect((res.body as any).error).toMatch(/exceeds the amount paid/i);
    expect(transferCreateMock).not.toHaveBeenCalled();
  });

  it("rejects a payment that has not succeeded", async () => {
    paymentIntentRetrieveMock.mockResolvedValue({
      id: "pi_123",
      status: "requires_payment_method",
      currency: "usd",
      metadata: {},
    });
    const res = makeRes();
    await handler(
      makeReq({ paymentIntentId: "pi_123", transferGroup: "cart_1_xyz" }),
      res
    );
    expect(res.statusCode).toBe(400);
    expect(transferCreateMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/stripe/process-transfers — legacy intents (splits in PI metadata)", () => {
  // Pre-persistence multi-seller intents carry the full split details as a
  // server-stamped JSON string in the PaymentIntent metadata.
  function useLegacyIntent(
    splits: unknown = [
      { pubkey: SELLER_A, amountCents: 500, accountId: "acct_a" },
    ],
    amount = 500,
    // Pre-compact-era creation time (2023): PI metadata splits are only
    // honored for intents old enough to be provably server-stamped.
    created = 1700000000
  ) {
    paymentIntentRetrieveMock.mockResolvedValue({
      id: "pi_legacy",
      status: "succeeded",
      currency: "usd",
      amount,
      created,
      transfer_group: "cart_legacy",
      metadata: {
        transferGroup: "cart_legacy",
        sellerSplits:
          typeof splits === "string" ? splits : JSON.stringify(splits),
      },
    });
    getPendingPaymentByIntentIdMock.mockResolvedValue(null);
  }

  it("pays out from the server-stamped PI metadata, not the request body", async () => {
    useLegacyIntent();
    const res = makeRes();
    await handler(
      makeReq({
        paymentIntentId: "pi_legacy",
        transferGroup: "cart_legacy",
        // No client splits at all — the metadata is sufficient.
      }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(transferCreateMock).toHaveBeenCalledTimes(1);
    const params = transferCreateMock.mock.calls[0][0] as any;
    expect(params.amount).toBe(500);
    expect(params.destination).toBe("acct_a");
    expect(params.transfer_group).toBe("cart_legacy");
  });

  it("fails closed when the client payload diverges from the stamped metadata", async () => {
    useLegacyIntent();
    const res = makeRes();
    await handler(
      makeReq({
        paymentIntentId: "pi_legacy",
        transferGroup: "cart_legacy",
        sellerSplits: [
          {
            pubkey: "e".repeat(64),
            amountCents: 500,
            accountId: "acct_evil",
          },
        ],
      }),
      res
    );
    expect(res.statusCode).toBe(400);
    expect(transferCreateMock).not.toHaveBeenCalled();
  });

  it("fails closed when the stamped metadata is malformed JSON", async () => {
    useLegacyIntent("{not json");
    const res = makeRes();
    await handler(
      makeReq({ paymentIntentId: "pi_legacy", transferGroup: "cart_legacy" }),
      res
    );
    expect(res.statusCode).toBe(409);
    expect((res.body as any).error).toMatch(/malformed/i);
    expect(transferCreateMock).not.toHaveBeenCalled();
  });

  it("fails closed when the stamped split total exceeds the amount paid", async () => {
    useLegacyIntent(
      [
        { pubkey: SELLER_A, amountCents: 400, accountId: "acct_a" },
        { pubkey: SELLER_B, amountCents: 400, accountId: "acct_b" },
      ],
      500 // buyer only paid 500
    );
    const res = makeRes();
    await handler(
      makeReq({ paymentIntentId: "pi_legacy", transferGroup: "cart_legacy" }),
      res
    );
    expect(res.statusCode).toBe(409);
    expect((res.body as any).error).toMatch(/exceeds the amount paid/i);
    expect(transferCreateMock).not.toHaveBeenCalled();
  });

  it("refuses a recordless compact-era intent whose metadata splits could be caller-injected", async () => {
    // During the transitional era the PI carried a genuine server-generated
    // transfer_group, but caller-supplied metadata.sellerSplits survived
    // verbatim and the pending record write was best-effort (and prunable).
    // This exact shape must never be paid out from metadata.
    useLegacyIntent(undefined, 500, 1789607000); // after the cutover
    const res = makeRes();
    await handler(
      makeReq({ paymentIntentId: "pi_legacy", transferGroup: "cart_legacy" }),
      res
    );
    expect(res.statusCode).toBe(409);
    expect((res.body as any).error).toMatch(/provably server-stamped/i);
    expect(transferCreateMock).not.toHaveBeenCalled();
  });

  it("fails closed when a legacy split names a seller outside the stamped seller list", async () => {
    useLegacyIntent();
    // The compact server-owned pubkey list names a DIFFERENT seller than the
    // split metadata — the two server signals contradict each other.
    paymentIntentRetrieveMock.mockResolvedValue({
      id: "pi_legacy",
      status: "succeeded",
      currency: "usd",
      amount: 500,
      created: 1700000000,
      transfer_group: "cart_legacy",
      metadata: {
        transferGroup: "cart_legacy",
        sellerSplits: JSON.stringify([
          { pubkey: SELLER_A, amountCents: 500, accountId: "acct_a" },
        ]),
        sellerSplitPubkeys: "e".repeat(64),
      },
    });
    const res = makeRes();
    await handler(
      makeReq({ paymentIntentId: "pi_legacy", transferGroup: "cart_legacy" }),
      res
    );
    expect(res.statusCode).toBe(409);
    expect((res.body as any).error).toMatch(/outside the stamped seller set/i);
    expect(transferCreateMock).not.toHaveBeenCalled();
  });

  it("fails closed for a recognized multi-merchant intent with no usable authority anywhere", async () => {
    // Marked as multi-merchant but neither a pending record nor metadata
    // splits exist (e.g. an intent from the brief window where only the
    // compact pubkey list was stamped and the row is gone).
    paymentIntentRetrieveMock.mockResolvedValue({
      id: "pi_gap",
      status: "succeeded",
      currency: "usd",
      amount: 1000,
      transfer_group: "cart_gap",
      metadata: {
        isMultiMerchant: "true",
        transferGroup: "cart_gap",
        sellerSplitPubkeys: `${SELLER_A},${SELLER_B}`,
      },
    });
    getPendingPaymentByIntentIdMock.mockResolvedValue(null);
    const res = makeRes();
    await handler(
      makeReq({
        paymentIntentId: "pi_gap",
        transferGroup: "cart_gap",
        sellerSplits: [
          { pubkey: SELLER_A, amountCents: 900, accountId: "acct_evil" },
        ],
      }),
      res
    );
    expect(res.statusCode).toBe(409);
    expect((res.body as any).error).toMatch(/split record is missing/i);
    expect(transferCreateMock).not.toHaveBeenCalled();
  });
});
