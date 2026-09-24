/** @jest-environment node */

// Route-level coverage for the MULTI-MERCHANT branch of
// pages/api/stripe/create-cart-subscription.ts: a recurring cart with 2+
// sellers must create successfully even though the full per-seller split
// details JSON (pubkey + amounts + donation fields per seller) far exceeds
// Stripe's 500-char metadata cap. The route persists the full splits
// server-side in stripe_pending_payments keyed by the transfer group and
// stamps only compact metadata on the Stripe subscription; the invoice.paid
// webhook (covered in webhook-connected-account.test.ts) resolves splits
// from that record.

const applyRateLimitMock = jest.fn();
const getStripeConnectAccountMock = jest.fn();
const createSubscriptionMock = jest.fn();
const recordPendingPaymentMock = jest.fn();
const stableIdempotencyKeyMock = jest.fn(
  (..._args: unknown[]) => "cartsub_test_key"
);
const reclaimPendingPaymentMock = jest.fn();
const updatePendingPaymentMock = jest.fn();
const getPendingPaymentMock = jest.fn();
const getSellerDonationPercentMock = jest.fn();
const registerApplePayDomainMock = jest.fn();
const trustedRegistrationHostMock = jest.fn();

const stripeCustomersListMock = jest.fn();
const stripeCustomersCreateMock = jest.fn();
const stripeProductsCreateMock = jest.fn();
const stripePricesCreateMock = jest.fn();
const stripeInvoiceItemsCreateMock = jest.fn();
const stripeInvoiceItemsDelMock = jest.fn();
const stripeSubscriptionsCreateMock = jest.fn();
const stripeInvoicePaymentsListMock = jest.fn();
const stripePaymentIntentsRetrieveMock = jest.fn();

jest.mock("stripe", () => {
  const Stripe = jest.fn().mockImplementation(() => ({
    customers: {
      list: (...args: unknown[]) => stripeCustomersListMock(...args),
      create: (...args: unknown[]) => stripeCustomersCreateMock(...args),
    },
    products: {
      create: (...args: unknown[]) => stripeProductsCreateMock(...args),
    },
    prices: {
      create: (...args: unknown[]) => stripePricesCreateMock(...args),
    },
    invoiceItems: {
      create: (...args: unknown[]) => stripeInvoiceItemsCreateMock(...args),
      del: (...args: unknown[]) => stripeInvoiceItemsDelMock(...args),
    },
    invoicePayments: {
      list: (...args: unknown[]) => stripeInvoicePaymentsListMock(...args),
    },
    paymentIntents: {
      retrieve: (...args: unknown[]) =>
        stripePaymentIntentsRetrieveMock(...args),
    },
    subscriptions: {
      create: (...args: unknown[]) => stripeSubscriptionsCreateMock(...args),
    },
  }));
  return { __esModule: true, default: Stripe };
});

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: (...args: unknown[]) => applyRateLimitMock(...args),
}));

jest.mock("@/utils/db/db-service", () => ({
  // db-service-mock-getdbpool: utils/db/* call getDbPool() at module scope.
  getDbPool: jest.fn(),
  getStripeConnectAccount: (...args: unknown[]) =>
    getStripeConnectAccountMock(...args),
  createSubscription: (...args: unknown[]) => createSubscriptionMock(...args),
}));

jest.mock("@/utils/stripe/retry-service", () => ({
  withStripeRetry: (fn: () => unknown) => fn(),
  stableIdempotencyKey: (...args: unknown[]) =>
    stableIdempotencyKeyMock(...args),
}));

jest.mock("@/utils/stripe/donation", () => {
  const actual = jest.requireActual("@/utils/stripe/donation");
  return {
    ...actual,
    getSellerDonationPercent: (...args: unknown[]) =>
      getSellerDonationPercentMock(...args),
  };
});

jest.mock("@/utils/stripe/apple-pay", () => ({
  registerApplePayDomain: (...args: unknown[]) =>
    registerApplePayDomainMock(...args),
  trustedRegistrationHost: (...args: unknown[]) =>
    trustedRegistrationHostMock(...args),
}));

jest.mock("@/utils/stripe/pending-payments", () => ({
  recordPendingPayment: (...args: unknown[]) =>
    recordPendingPaymentMock(...args),
  reclaimPendingPayment: (...args: unknown[]) =>
    reclaimPendingPaymentMock(...args),
  updatePendingPayment: (...args: unknown[]) =>
    updatePendingPaymentMock(...args),
  getPendingPayment: (...args: unknown[]) => getPendingPaymentMock(...args),
  SPLIT_AUTHORITY_METADATA_KEY: "ssSplitAuthority",
  SPLIT_AUTHORITY_PENDING_RECORD: "pending-record-v1",
  SUBSCRIPTION_ATTEMPT_TRACKED_METADATA_KEY: "subscriptionAttemptTracked",
  SUBSCRIPTION_CREATE_ATTEMPTED_METADATA_KEY: "subscriptionCreateAttemptedAt",
  SUBSCRIPTION_CREATE_FAILED_METADATA_KEY: "subscriptionCreateFailedAt",
}));

import handler from "@/pages/api/stripe/create-cart-subscription";

const SELLER_A = "a".repeat(64);
const SELLER_B = "b".repeat(64);
const SELLER_C = "e".repeat(64);
const PLATFORM_PK = "f".repeat(64);

const originalPlatformPk = process.env.NEXT_PUBLIC_SELF_SOWN_PK;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.NEXT_PUBLIC_SELF_SOWN_PK = PLATFORM_PK;
  applyRateLimitMock.mockResolvedValue(true);
  getStripeConnectAccountMock.mockImplementation(async (pubkey: string) => ({
    stripe_account_id:
      pubkey === SELLER_A
        ? "acct_seller_a"
        : pubkey === SELLER_B
          ? "acct_seller_b"
          : "acct_seller_c",
    charges_enabled: true,
  }));
  getSellerDonationPercentMock.mockResolvedValue(2);
  trustedRegistrationHostMock.mockResolvedValue(null);
  registerApplePayDomainMock.mockResolvedValue(undefined);
  recordPendingPaymentMock.mockResolvedValue({
    created: true,
    claimToken: "tok_1",
  }); // this attempt owns the claim
  reclaimPendingPaymentMock.mockResolvedValue(null); // default: reclaim denied
  updatePendingPaymentMock.mockResolvedValue(undefined);
  // Default: no prior attempt for this cart (full Stripe creation path).
  getPendingPaymentMock.mockResolvedValue(null);
  createSubscriptionMock.mockResolvedValue(undefined);

  stripeCustomersListMock.mockResolvedValue({ data: [] });
  stripeCustomersCreateMock.mockResolvedValue({ id: "cus_buyer" });
  let productCounter = 0;
  stripeProductsCreateMock.mockImplementation(async () => ({
    id: `prod_${++productCounter}`,
  }));
  let priceCounter = 0;
  stripePricesCreateMock.mockImplementation(async () => ({
    id: `price_${++priceCounter}`,
  }));
  stripeInvoiceItemsCreateMock.mockResolvedValue({ id: "ii_1" });
  // Default fixture is the REAL apiVersion 2025-09-30.clover (Basil) shape:
  // the Invoice has NO top-level payment_intent, so the route must resolve
  // the first-payment PI via the invoice's invoicePayments entries.
  stripeSubscriptionsCreateMock.mockResolvedValue({
    id: "sub_cart_1",
    status: "incomplete",
    current_period_end: 1_800_000_000,
    latest_invoice: { id: "in_1" },
  });
  stripeInvoicePaymentsListMock.mockResolvedValue({
    data: [{ payment: { payment_intent: "pi_1" } }],
  });
  stripePaymentIntentsRetrieveMock.mockResolvedValue({
    id: "pi_1",
    client_secret: "pi_1_secret",
  });
});

afterAll(() => {
  process.env.NEXT_PUBLIC_SELF_SOWN_PK = originalPlatformPk;
});

function makeReq(body: unknown) {
  return { method: "POST", headers: {}, body } as any;
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

function twoSellerCartBody() {
  return {
    customerEmail: "buyer@example.com",
    buyerPubkey: "c".repeat(64),
    items: [
      {
        productTitle: "Weekly Raw Milk Share",
        productEventId: "evt_milk",
        amount: 12.5,
        currency: "usd",
        quantity: 1,
        isSubscription: true,
        frequency: "weekly",
        subscriptionDiscount: 10,
        sellerPubkey: SELLER_A,
      },
      {
        productTitle: "Pastured Eggs Monthly",
        productEventId: "evt_eggs",
        amount: 18,
        currency: "usd",
        quantity: 2,
        isSubscription: true,
        frequency: "weekly",
        sellerPubkey: SELLER_B,
      },
      {
        productTitle: "One-time Honey Jar",
        productEventId: "evt_honey",
        amount: 9,
        currency: "usd",
        quantity: 1,
        isSubscription: false,
        sellerPubkey: SELLER_B,
      },
      {
        productTitle: "Grass-fed Beef Box",
        productEventId: "evt_beef",
        amount: 40,
        currency: "usd",
        quantity: 1,
        isSubscription: true,
        frequency: "monthly",
        sellerPubkey: SELLER_C,
      },
    ],
  };
}

describe("POST /api/stripe/create-cart-subscription — multi-merchant", () => {
  it("creates a 2-seller recurring cart whose split JSON exceeds Stripe's 500-char metadata cap", async () => {
    const res = makeRes();
    await handler(makeReq(twoSellerCartBody()), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.isMultiMerchant).toBe(true);
    expect(res.body.subscriptionId).toBe("sub_cart_1");
    expect(res.body.clientSecret).toBe("pi_1_secret");

    // The full split details genuinely exceed the cap this fix works around
    // — pin that so the test can't silently stop exercising the regression.
    const fullSplitsJson = JSON.stringify(res.body.sellerSplits);
    expect(fullSplitsJson.length).toBeGreaterThan(500);

    // Full splits persisted server-side keyed by the transfer group.
    expect(recordPendingPaymentMock).toHaveBeenCalledTimes(1);
    const record = recordPendingPaymentMock.mock.calls[0][0];
    expect(record.intentRef).toBe(res.body.transferGroup);
    // Deterministic per buyer+cart: the SAME retry request must land on the
    // SAME record (stableIdempotencyKey is mocked to "cartsub_test_key").
    expect(res.body.transferGroup).toBe("cart_sub_cartsub_test_key");
    expect(record.currency).toBe("usd");
    expect(record.amount).toBe(
      res.body.sellerSplits.reduce(
        (sum: number, s: any) => sum + s.amountCents,
        0
      )
    );
    expect(record.metadata.sellerSplits).toEqual(res.body.sellerSplits);

    // Per-price seller allocation lets the webhook pay each invoice from its
    // own lines. It is stamped into the record via the phase-3 metadata
    // update (after the prices exist). Creation order: recurring items first
    // (milk→A, eggs→B, beef→C), then one-time (honey→B).
    const allocationUpdate = updatePendingPaymentMock.mock.calls.find(
      (call) => call[1]?.metadata?.priceAllocations
    );
    expect(allocationUpdate).toBeDefined();
    expect(allocationUpdate![0]).toBe(res.body.transferGroup);
    expect(allocationUpdate![1].metadata.priceAllocations).toEqual([
      {
        priceId: "price_1",
        sellerPubkey: SELLER_A,
        quantity: 1,
        recurring: true,
      },
      {
        priceId: "price_2",
        sellerPubkey: SELLER_B,
        quantity: 1,
        recurring: true,
      },
      {
        priceId: "price_3",
        sellerPubkey: SELLER_C,
        quantity: 1,
        recurring: true,
      },
      {
        priceId: "price_4",
        sellerPubkey: SELLER_B,
        quantity: 1,
        recurring: false,
      },
    ]);
    expect(allocationUpdate![1].metadata.sellerSplits).toEqual(
      res.body.sellerSplits
    );

    // Seller A: 1250 * 0.9 = 1125; seller B: 1800*2 + 900 = 4500;
    // seller C: 4000.
    const splitsByPubkey = new Map(
      res.body.sellerSplits.map((s: any) => [s.pubkey, s])
    );
    expect((splitsByPubkey.get(SELLER_A) as any).amountCents).toBe(1125);
    expect((splitsByPubkey.get(SELLER_A) as any).accountId).toBe(
      "acct_seller_a"
    );
    // amount is the LINE TOTAL (client sends basePrice × quantity): the
    // qty-2 eggs item contributes 1800, never 1800 × 2.
    expect((splitsByPubkey.get(SELLER_B) as any).amountCents).toBe(2700);
    expect((splitsByPubkey.get(SELLER_B) as any).accountId).toBe(
      "acct_seller_b"
    );
    expect((splitsByPubkey.get(SELLER_C) as any).amountCents).toBe(4000);

    // Quantity regression pin: Stripe prices carry the line total as
    // unit_amount and EVERY line item has quantity 1 — a qty-2 cart item
    // must never be double-multiplied into the charge.
    expect(
      stripePricesCreateMock.mock.calls.map(([p]: any[]) => p.unit_amount)
    ).toEqual([1125, 1800, 4000, 900]);
    const createdItems = stripeSubscriptionsCreateMock.mock.calls[0][0].items;
    expect(createdItems.every((i: any) => i.quantity === 1)).toBe(true);
    // One-time items are atomic with the subscription (add_invoice_items):
    // the qty-2 eggs line rides the create itself, still quantity 1.
    expect(
      stripeSubscriptionsCreateMock.mock.calls[0][0].add_invoice_items
    ).toEqual([{ price: "price_4", quantity: 1 }]);
    expect((splitsByPubkey.get(SELLER_C) as any).accountId).toBe(
      "acct_seller_c"
    );

    // The Stripe subscription metadata stays compact: no sellerSplits key,
    // and every value fits the 500-char cap.
    const subParams = stripeSubscriptionsCreateMock.mock.calls[0][0];
    expect(subParams.metadata.sellerSplits).toBeUndefined();
    expect(subParams.metadata.transferGroup).toBe(res.body.transferGroup);
    // The authority marker tells the webhook to fail closed if the split
    // record is ever missing rather than silently skipping payouts.
    expect(subParams.metadata.ssSplitAuthority).toBe("pending-record-v1");
    for (const value of Object.values(
      subParams.metadata as Record<string, string>
    )) {
      expect(String(value).length).toBeLessThanOrEqual(500);
    }

    // The durable record is marked live once the subscription exists, with
    // the Stripe identity persisted for reconciliation.
    const liveMark = updatePendingPaymentMock.mock.calls.find(
      (c) => c[1]?.status === "created"
    );
    expect(liveMark).toBeDefined();
    expect(liveMark![0]).toBe(res.body.transferGroup);
    expect(liveMark![1].metadata.stripeSubscriptionId).toBe("sub_cart_1");
    expect(liveMark![1].metadata.stripeCustomerId).toBe("cus_buyer");
    expect(liveMark![1].metadata.sellerSplits).toEqual(res.body.sellerSplits);

    // A subscriptions row per recurring item is recorded for renewals.
    expect(createSubscriptionMock).toHaveBeenCalledTimes(3);
  });

  it("fails closed (500, no Stripe mutations) when the authoritative split record cannot be persisted", async () => {
    // The webhook pays sellers out of this record, so a recurring cart whose
    // split record can't be durably saved must NOT become payable — and the
    // write happens BEFORE any Stripe object creation so the buyer's retry
    // starts completely clean (no orphaned pending invoice items to
    // double-charge).
    recordPendingPaymentMock.mockRejectedValue(new Error("db down"));

    const res = makeRes();
    await handler(makeReq(twoSellerCartBody()), res);

    expect(res.statusCode).toBe(500);
    expect(stripeSubscriptionsCreateMock).not.toHaveBeenCalled();
    expect(stripeProductsCreateMock).not.toHaveBeenCalled();
    expect(stripePricesCreateMock).not.toHaveBeenCalled();
    expect(stripeInvoiceItemsCreateMock).not.toHaveBeenCalled();
    // Not even a customer object — the record write precedes EVERY Stripe
    // mutation, so a retry starts with zero Stripe footprint.
    expect(stripeCustomersCreateMock).not.toHaveBeenCalled();
  });

  it("a pre-stamp failure leaves zero invoice-item footprint, so a retry cannot double-charge", async () => {
    // Attempt 1 fails at the allocations STAMP. One-time items ride the
    // subscription create (add_invoice_items) — atomic with it — so a
    // failed attempt leaves NOTHING pending on the customer to leak into
    // any later first invoice.
    updatePendingPaymentMock.mockRejectedValueOnce(new Error("db down"));
    // Attempt 1 owns the claim; attempt 2 finds the row already present but
    // RELEASED by the failed attempt — an immediate retry must take over,
    // not 409 until the record goes stale.
    recordPendingPaymentMock
      .mockResolvedValueOnce({ created: true, claimToken: "tok_1" })
      .mockResolvedValue({ created: false, claimToken: null });
    // Attempt 2 wins the fenced reclaim of the released record (rotated
    // token — a resumed stale owner's writes would no longer match).
    reclaimPendingPaymentMock.mockResolvedValueOnce("tok_2");
    getPendingPaymentMock.mockResolvedValue({
      intentRef: "cart_sub_cartsub_test_key",
      status: "failed_terminal",
      metadata: { transferGroup: "cart_sub_cartsub_test_key" },
      updatedAt: Date.now(),
    } as any);

    const res1 = makeRes();
    await handler(makeReq(twoSellerCartBody()), res1);
    expect(res1.statusCode).toBe(500);
    // No pending invoice items exist — there is nothing to clean up.
    expect(stripeInvoiceItemsCreateMock).not.toHaveBeenCalled();
    expect(stripeInvoiceItemsDelMock).not.toHaveBeenCalled();
    // The failure happened before the subscription create was reached, and
    // the failed attempt released its claim for the retry.
    expect(stripeSubscriptionsCreateMock).not.toHaveBeenCalled();
    expect(
      updatePendingPaymentMock.mock.calls.some(
        (c) => c[1]?.status === "failed_terminal"
      )
    ).toBe(true);

    // Attempt 2 (the buyer's retry) succeeds; its one-time item rides the
    // subscription create itself (attempt 1 made prices 1–4, so the retry's
    // one-time price is price_8).
    const res2 = makeRes();
    await handler(makeReq(twoSellerCartBody()), res2);
    expect(res2.statusCode).toBe(200);
    expect(stripeInvoiceItemsCreateMock).not.toHaveBeenCalled();
    expect(stripeInvoiceItemsDelMock).not.toHaveBeenCalled();
    expect(stripeSubscriptionsCreateMock).toHaveBeenCalledTimes(1);
    expect(
      stripeSubscriptionsCreateMock.mock.calls[0][0].add_invoice_items
    ).toEqual([{ price: "price_8", quantity: 1 }]);
    // The idempotency key IS the deterministic transfer group.
    expect(stripeSubscriptionsCreateMock.mock.calls[0][1]?.idempotencyKey).toBe(
      "cart_sub_cartsub_test_key"
    );
  });

  it("replays the SAME Stripe subscription when a retry follows a post-create failure", async () => {
    // Emulate Stripe idempotency semantics: a key reused with identical
    // params replays the original object; reused with different params it
    // errors. The retry below is safe ONLY because the replay path rebuilds
    // the params from the record's stored price ids.
    const createdByKey = new Map<string, string>();
    const stripeSub = {
      id: "sub_cart_1",
      status: "incomplete",
      current_period_end: 1_800_000_000,
      // Clover shape: no top-level payment_intent on the invoice.
      latest_invoice: { id: "in_1" },
    };
    stripeSubscriptionsCreateMock.mockImplementation(
      async (params: any, opts: any) => {
        const key = opts?.idempotencyKey;
        const signature = JSON.stringify(params);
        const prior = createdByKey.get(key);
        if (prior !== undefined) {
          if (prior !== signature) {
            throw new Error(
              "Keys for idempotent requests can only be used with the same parameters"
            );
          }
          return stripeSub;
        }
        createdByKey.set(key, signature);
        return stripeSub;
      }
    );
    // Attempt 1 wins the atomic claim (creates everything); attempt 2 loses
    // it and replays from the record attempt 1 stamped — the record is only
    // read when the claim is lost.
    recordPendingPaymentMock
      .mockResolvedValueOnce({ created: true, claimToken: "tok_1" })
      .mockResolvedValue({ created: false, claimToken: null });
    getPendingPaymentMock.mockResolvedValue({
      intentRef: "cart_sub_cartsub_test_key",
      status: "pending",
      metadata: {
        transferGroup: "cart_sub_cartsub_test_key",
        priceAllocations: [
          {
            priceId: "price_1",
            sellerPubkey: SELLER_A,
            quantity: 1,
            recurring: true,
          },
          {
            priceId: "price_2",
            sellerPubkey: SELLER_B,
            quantity: 1,
            recurring: true,
          },
          {
            priceId: "price_3",
            sellerPubkey: SELLER_C,
            quantity: 1,
            recurring: true,
          },
          {
            priceId: "price_4",
            sellerPubkey: SELLER_B,
            quantity: 1,
            recurring: false,
          },
        ],
        kind: "cart-subscription",
      },
    } as any);
    // The Stripe subscription IS created on attempt 1; the per-item DB row
    // insert then fails — exactly the dangerous post-create failure window.
    createSubscriptionMock.mockRejectedValueOnce(new Error("db down"));

    const res1 = makeRes();
    await handler(makeReq(twoSellerCartBody()), res1);
    expect(res1.statusCode).toBe(500);
    expect(stripeSubscriptionsCreateMock).toHaveBeenCalledTimes(1);

    // Attempt 2: the retry must NOT create new Stripe objects — it reuses
    // the recorded price ids so the subscription create is a true replay.
    const res2 = makeRes();
    await handler(makeReq(twoSellerCartBody()), res2);
    expect(res2.statusCode).toBe(200);
    expect(res2.body.subscriptionId).toBe("sub_cart_1");

    expect(stripeSubscriptionsCreateMock).toHaveBeenCalledTimes(2);
    expect(createdByKey.size).toBe(1); // one Stripe subscription, replayed
    expect(stripeSubscriptionsCreateMock.mock.calls[1][0]).toEqual(
      stripeSubscriptionsCreateMock.mock.calls[0][0]
    );
    // No new products/prices/invoice items on the retry.
    expect(stripeProductsCreateMock).toHaveBeenCalledTimes(4);
    expect(stripePricesCreateMock).toHaveBeenCalledTimes(4);
    // One-time items ride the subscription create (add_invoice_items) —
    // no standalone pending invoice items exist on either attempt.
    expect(stripeInvoiceItemsCreateMock).not.toHaveBeenCalled();
    expect(stripeInvoiceItemsDelMock).not.toHaveBeenCalled();
    // The failed per-item row insert is retried: 1 reject + 3 successes.
    expect(createSubscriptionMock).toHaveBeenCalledTimes(4);
  });

  it("a tokenless replay (live owner) replays the Stripe objects but NEVER mutates the authority record", async () => {
    // The record carries stamped allocations from a LIVE in-flight owner:
    // this retry may replay the subscription create (same idempotency key,
    // same params) but must not write the record — a tokenless
    // updatePendingPayment is unconditional and could clobber the owner's
    // seller splits / donation fields with retry-time recomputations.
    recordPendingPaymentMock.mockResolvedValue({
      created: false,
      claimToken: null,
    });
    getPendingPaymentMock.mockResolvedValue({
      intentRef: "cart_sub_cartsub_test_key",
      status: "creating",
      metadata: {
        transferGroup: "cart_sub_cartsub_test_key",
        priceAllocations: [
          {
            priceId: "price_1",
            sellerPubkey: SELLER_A,
            quantity: 1,
            recurring: true,
          },
          {
            priceId: "price_2",
            sellerPubkey: SELLER_B,
            quantity: 1,
            recurring: true,
          },
        ],
        kind: "cart-subscription",
      },
    } as any);
    reclaimPendingPaymentMock.mockResolvedValue(null); // owner still live

    const res = makeRes();
    await handler(makeReq(twoSellerCartBody()), res);

    expect(res.statusCode).toBe(200);
    expect(stripeSubscriptionsCreateMock).toHaveBeenCalledTimes(1);
    expect(updatePendingPaymentMock).not.toHaveBeenCalled();
  });

  it("a replay that wins the fenced reclaim (dead owner) completes the record bookkeeping with the rotated token", async () => {
    recordPendingPaymentMock.mockResolvedValue({
      created: false,
      claimToken: null,
    });
    getPendingPaymentMock.mockResolvedValue({
      intentRef: "cart_sub_cartsub_test_key",
      status: "creating",
      metadata: {
        transferGroup: "cart_sub_cartsub_test_key",
        priceAllocations: [
          {
            priceId: "price_1",
            sellerPubkey: SELLER_A,
            quantity: 1,
            recurring: true,
          },
          {
            priceId: "price_2",
            sellerPubkey: SELLER_B,
            quantity: 1,
            recurring: true,
          },
        ],
        kind: "cart-subscription",
      },
    } as any);
    reclaimPendingPaymentMock.mockResolvedValue("tok_reclaim");

    const res = makeRes();
    await handler(makeReq(twoSellerCartBody()), res);

    expect(res.statusCode).toBe(200);
    expect(updatePendingPaymentMock).toHaveBeenCalledWith(
      "cart_sub_cartsub_test_key",
      expect.objectContaining({
        status: "created",
        claimToken: "tok_reclaim",
      })
    );
  });

  it("a failed attempt's one-time items can never bill on a LATER cart's first invoice", async () => {
    // Attempt 1 (cart v1) fails AT the subscription create, after the
    // allocation stamp. With add_invoice_items the one-time item is atomic
    // with the create — NOTHING is left pending on the shared customer.
    stripeSubscriptionsCreateMock.mockRejectedValueOnce(
      new Error("stripe down")
    );
    const res1 = makeRes();
    await handler(makeReq(twoSellerCartBody()), res1);
    expect(res1.statusCode).toBe(500);
    expect(stripeInvoiceItemsCreateMock).not.toHaveBeenCalled();
    expect(stripeInvoiceItemsDelMock).not.toHaveBeenCalled();
    const attempt1Create = stripeSubscriptionsCreateMock.mock.calls[0][0];
    const attempt1OneTimePrice = attempt1Create.add_invoice_items[0].price;

    // Attempt 2: the buyer CHANGES the cart (new nonce → new transfer group
    // → fresh authority record) but resolves to the SAME Stripe customer.
    // Its first invoice must carry ONLY attempt 2's own one-time price —
    // attempt 1's price is unreachable, so it can never be billed NOR reach
    // the webhook's allocation lookup as an unresolvable line.
    stableIdempotencyKeyMock.mockReturnValueOnce("cartsub_key_attempt2");
    const res2 = makeRes();
    await handler(makeReq(twoSellerCartBody()), res2);
    expect(res2.statusCode).toBe(200);

    const attempt2Create = stripeSubscriptionsCreateMock.mock.calls[1][0];
    expect(attempt2Create.add_invoice_items).toEqual([
      // Attempt 1 made prices 1–4; attempt 2's one-time price is price_8.
      { price: "price_8", quantity: 1 },
    ]);
    expect(attempt2Create.add_invoice_items[0].price).not.toBe(
      attempt1OneTimePrice
    );
    expect(stripeInvoiceItemsCreateMock).not.toHaveBeenCalled();
  });

  it("stamps the conclusive-failure marker when Stripe refuses the create with a 4xx, but not for an ambiguous timeout", async () => {
    // #436: the prune sweep deletes split records only with durable proof
    // that no subscription exists. A 4xx is a processed refusal — an
    // idempotent replay returns the same refusal, so nothing exists under
    // the key. A timeout/5xx is ambiguous: Stripe may hold a live
    // subscription, and the webhook pays renewals out of this record
    // regardless of status, so the marker must NOT be stamped.
    const stripeRefusal = Object.assign(new Error("card declined"), {
      statusCode: 402,
    });
    stripeSubscriptionsCreateMock.mockRejectedValueOnce(stripeRefusal);
    // The catch re-reads the record to merge the marker without clobbering
    // the stamped allocations.
    getPendingPaymentMock.mockResolvedValueOnce({
      intentRef: "cart_sub_cartsub_test_key",
      status: "creating",
      metadata: {
        transferGroup: "cart_sub_cartsub_test_key",
        sellerSplits: [{ pubkey: SELLER_A, amountCents: 100 }],
        priceAllocations: [
          {
            priceId: "price_1",
            sellerPubkey: SELLER_A,
            quantity: 1,
            recurring: true,
          },
        ],
        kind: "cart-subscription",
        subscriptionAttemptTracked: true,
        subscriptionCreateAttemptedAt: Date.now(),
      },
    } as any);

    const res1 = makeRes();
    await handler(makeReq(twoSellerCartBody()), res1);
    expect(res1.statusCode).toBe(500);

    const conclusiveRelease = updatePendingPaymentMock.mock.calls.find(
      (c) => c[1]?.status === "failed_terminal"
    );
    expect(conclusiveRelease).toBeDefined();
    expect(conclusiveRelease![1].metadata.subscriptionCreateFailedAt).toEqual(
      expect.any(Number)
    );
    // The merge preserved the pre-existing allocation data.
    expect(conclusiveRelease![1].metadata.priceAllocations).toHaveLength(1);
    // The pre-create marker was stamped BEFORE the create call.
    const attemptStamp = updatePendingPaymentMock.mock.calls.find(
      (c) => c[1]?.metadata?.subscriptionCreateAttemptedAt
    );
    expect(attemptStamp).toBeDefined();

    // Attempt 2: the create TIMES OUT (no statusCode) — ambiguous. The
    // release must carry NO conclusive-failure marker so the record stays
    // unprunable while a live subscription may exist at Stripe.
    jest.clearAllMocks();
    recordPendingPaymentMock.mockResolvedValue({
      created: true,
      claimToken: "tok_1",
    });
    reclaimPendingPaymentMock.mockResolvedValue(null);
    updatePendingPaymentMock.mockResolvedValue(undefined);
    getPendingPaymentMock.mockResolvedValue(null);
    getSellerDonationPercentMock.mockResolvedValue(2);
    trustedRegistrationHostMock.mockResolvedValue(null);
    registerApplePayDomainMock.mockResolvedValue(undefined);
    createSubscriptionMock.mockResolvedValue(undefined);
    applyRateLimitMock.mockResolvedValue(true);
    stripeSubscriptionsCreateMock.mockRejectedValueOnce(
      new Error("read ETIMEDOUT")
    );

    const res2 = makeRes();
    await handler(makeReq(twoSellerCartBody()), res2);
    expect(res2.statusCode).toBe(500);

    const ambiguousRelease = updatePendingPaymentMock.mock.calls.find(
      (c) => c[1]?.status === "failed_terminal"
    );
    expect(ambiguousRelease).toBeDefined();
    expect(ambiguousRelease![1].metadata).toBeUndefined();
  });

  it("of two simultaneous retries after a failed attempt, exactly one wins the reclaim fence and the other 409s", async () => {
    recordPendingPaymentMock.mockResolvedValue({
      created: false,
      claimToken: null,
    }); // both lost the insert claim
    getPendingPaymentMock.mockResolvedValue({
      intentRef: "cart_sub_cartsub_test_key",
      status: "failed_terminal",
      metadata: { transferGroup: "cart_sub_cartsub_test_key" },
      updatedAt: Date.now(),
    } as any);
    reclaimPendingPaymentMock
      .mockResolvedValueOnce("tok_2") // first retry wins the fence
      .mockResolvedValue(null); // every concurrent loser backs off

    const res1 = makeRes();
    const res2 = makeRes();
    await Promise.all([
      handler(makeReq(twoSellerCartBody()), res1),
      handler(makeReq(twoSellerCartBody()), res2),
    ]);

    expect([res1.statusCode, res2.statusCode].sort()).toEqual([200, 409]);
    // Exactly ONE creator ran the Stripe object sequence — no competing
    // Price ids under the shared subscription idempotency key.
    expect(stripeSubscriptionsCreateMock).toHaveBeenCalledTimes(1);
  });

  it("keeps every Stripe metadata value within the 500-char cap for carts with long Nostr product coordinates", async () => {
    // Realistic kind:30402 coordinates (~118 chars each) — a moderate cart
    // of these is exactly what used to blow the metadata cap.
    const coord = (n: number) =>
      `30402:${"f".repeat(64)}:${"g".repeat(40)}-${n}`;
    const body = twoSellerCartBody();
    body.items = body.items.map((item, i) => ({
      ...item,
      productEventId: coord(i),
    }));

    const res = makeRes();
    await handler(makeReq(body), res);
    expect(res.statusCode).toBe(200);

    const meta = stripeSubscriptionsCreateMock.mock.calls[0][0].metadata;
    for (const value of Object.values(meta)) {
      expect(String(value).length).toBeLessThanOrEqual(500);
    }
    // The product lists are NOT in Stripe metadata anymore — they live in
    // the JSONB authority record (no cap).
    expect(meta.subscriptionProductIds).toBeUndefined();
    expect(meta.oneTimeProductIds).toBeUndefined();
    expect(
      recordPendingPaymentMock.mock.calls[0][0].metadata.productEventIds
    ).toHaveLength(4);
  });

  it("a stale owner resuming after a reclaim cannot overwrite the new owner's record", async () => {
    // Attempt A claimed with tok_A, went stale (>2min), and a retry
    // reclaimed the record with a rotated token. A's resumed writes still
    // carry tok_A, so the token-gated stamp matches zero rows and throws —
    // A aborts instead of clobbering the new owner's allocations.
    recordPendingPaymentMock.mockResolvedValue({
      created: true,
      claimToken: "tok_A",
    });
    updatePendingPaymentMock.mockRejectedValueOnce(
      new Error("Pending payment cart_sub_cartsub_test_key claim lost")
    );

    const res = makeRes();
    await handler(makeReq(twoSellerCartBody()), res);

    expect(res.statusCode).toBe(500);
    // A never reached the subscription create...
    expect(stripeSubscriptionsCreateMock).not.toHaveBeenCalled();
    // ...and BOTH of its record writes were token-gated, so neither can
    // clobber the new owner's record.
    expect(updatePendingPaymentMock.mock.calls[0][1].claimToken).toBe("tok_A");
    const releaseCall = updatePendingPaymentMock.mock.calls.find(
      (c) => c[1]?.status === "failed_terminal"
    );
    expect(releaseCall).toBeDefined();
    expect(releaseCall![1].claimToken).toBe("tok_A");
  });

  it("rejects a guest multi-seller recurring cart — nobody could manage the shared subscription later", async () => {
    // Whole-subscription mutations (cancel, address, billing date) are
    // buyer-only for multi-seller subscriptions. A guest checkout stores no
    // buyer pubkey, so the shared subscription would be unmanageable
    // forever — fail closed at creation instead of bricking its lifecycle.
    const body = twoSellerCartBody() as Record<string, unknown>;
    delete body.buyerPubkey;

    const res = makeRes();
    await handler(makeReq(body), res);

    expect(res.statusCode).toBe(400);
    expect(recordPendingPaymentMock).not.toHaveBeenCalled();
    expect(stripeSubscriptionsCreateMock).not.toHaveBeenCalled();
  });

  it("a 100%-donation seller creates fine and records a full-amount cut (payout skips the zero-net transfer)", async () => {
    // 100% is a supported seller setting — creation must persist it
    // verbatim with the shared contract's full-amount cut so the invoice
    // webhook resolves the seller durably instead of retrying forever.
    getSellerDonationPercentMock.mockImplementation(async (pk: string) =>
      pk === SELLER_A ? 100 : 0
    );

    const res = makeRes();
    await handler(makeReq(twoSellerCartBody()), res);

    expect(res.statusCode).toBe(200);
    const recorded = recordPendingPaymentMock.mock.calls[0][0];
    const splits = recorded.metadata.sellerSplits as any[];
    const splitA = splits.find((s) => s.pubkey === SELLER_A);
    expect(splitA.donationPercent).toBe(100);
    expect(splitA.donationCutSmallest).toBe(splitA.amountCents);
    expect(splitA.amountCents).toBeGreaterThan(0);
  });

  it("resolves the buyer's clientSecret via invoicePayments on the clover invoice shape", async () => {
    // #439: apiVersion 2025-09-30.clover (Basil family) removed
    // Invoice.payment_intent, so expand:["latest_invoice.payment_intent"]
    // silently yields nothing — the buyer's card form is gated on this
    // secret, and a null here means the form never renders.
    const res = makeRes();
    await handler(makeReq(twoSellerCartBody()), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.clientSecret).toBe("pi_1_secret");
    expect(stripeInvoicePaymentsListMock).toHaveBeenCalledWith(
      { invoice: "in_1", limit: 10 },
      undefined
    );
    expect(stripePaymentIntentsRetrieveMock).toHaveBeenCalledWith(
      "pi_1",
      {},
      undefined
    );
  });

  it("still resolves the pre-Basil expanded shape without the invoicePayments fallback", async () => {
    // If the API version pin ever rolls back, the expanded
    // latest_invoice.payment_intent must be used directly — the extra calls
    // must NOT fire (and nothing may 500 on their absence).
    stripeSubscriptionsCreateMock.mockResolvedValue({
      id: "sub_cart_1",
      status: "incomplete",
      current_period_end: 1_800_000_000,
      latest_invoice: {
        id: "in_1",
        payment_intent: { id: "pi_1", client_secret: "pi_1_secret" },
      },
    });

    const res = makeRes();
    await handler(makeReq(twoSellerCartBody()), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.clientSecret).toBe("pi_1_secret");
    expect(stripeInvoicePaymentsListMock).not.toHaveBeenCalled();
    expect(stripePaymentIntentsRetrieveMock).not.toHaveBeenCalled();
  });

  it("409s a concurrent duplicate while the owning attempt is still creating Stripe objects", async () => {
    // Lost the atomic claim and the record has no allocations yet — the
    // owner is mid-creation, so this request must NOT create competing
    // Stripe objects under the shared idempotency key (Stripe would accept
    // only one param set, and the record can only point at one).
    recordPendingPaymentMock.mockResolvedValue({
      created: false,
      claimToken: null,
    });
    getPendingPaymentMock.mockResolvedValue({
      intentRef: "cart_sub_cartsub_test_key",
      status: "creating",
      metadata: { transferGroup: "cart_sub_cartsub_test_key" },
      updatedAt: Date.now(),
    } as any);

    const res = makeRes();
    await handler(makeReq(twoSellerCartBody()), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe("CHECKOUT_IN_PROGRESS");
    expect(stripeProductsCreateMock).not.toHaveBeenCalled();
    expect(stripeSubscriptionsCreateMock).not.toHaveBeenCalled();
    expect(stripeInvoiceItemsCreateMock).not.toHaveBeenCalled();
  });
});
