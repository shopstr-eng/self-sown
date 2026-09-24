/** @jest-environment node */

// Route-level coverage for the web (Stripe) auto-label-purchase endpoint
// (pages/api/shipping/auto-purchase.ts). This endpoint takes no Nostr proof —
// its authorization is a re-verified, settled PaymentIntent PLUS the
// checkout-time binding recorded at payment creation. These tests pin the
// money-safety gates so a buyer can never make a seller buy a label without
// a real payment that names that seller:
//   - A PaymentIntent that isn't `succeeded` is rejected (no core call).
//   - A PaymentIntent whose metadata doesn't name this seller is rejected.
//   - A missing / unretrievable PaymentIntent is rejected.
//   - Single-seller charges are looked up on the connected account, with a
//     platform-account fallback for multi-merchant charges.
//   - The order, product, and destination come from the server-side
//     checkout-time record (keyed by the VERIFIED PaymentIntent id) — the
//     request body's orderId/productId/toAddress are ignored entirely, so a
//     buyer cannot pay cheap shipping to one address and then trigger the
//     seller-billed label to another.
//   - A settled, seller-matching payment with NO recorded binding fails
//     closed (no label).

const applyRateLimitMock = jest.fn();
const isShippoOAuthConfiguredMock = jest.fn();
const getStripeConnectAccountMock = jest.fn();
const getShippingCheckoutContextMock = jest.fn();
const runAutoLabelPurchaseMock = jest.fn();
const retrieveMock = jest.fn();

jest.mock("stripe", () => {
  const Stripe = jest.fn().mockImplementation(() => ({
    paymentIntents: {
      retrieve: (...args: unknown[]) => retrieveMock(...args),
    },
  }));
  return { __esModule: true, default: Stripe };
});

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: (...args: unknown[]) => applyRateLimitMock(...args),
}));

jest.mock("@/utils/shipping/shippo-oauth", () => ({
  isShippoOAuthConfigured: (...args: unknown[]) =>
    isShippoOAuthConfiguredMock(...args),
}));

jest.mock("@/utils/db/db-service", () => ({
  getStripeConnectAccount: (...args: unknown[]) =>
    getStripeConnectAccountMock(...args),
}));

jest.mock("@/utils/db/shipping-service", () => ({
  getShippingCheckoutContext: (...args: unknown[]) =>
    getShippingCheckoutContextMock(...args),
}));

jest.mock("@/utils/shipping/auto-purchase", () => ({
  runAutoLabelPurchase: (...args: unknown[]) =>
    runAutoLabelPurchaseMock(...args),
}));

import handler from "@/pages/api/shipping/auto-purchase";

const SELLER = "a".repeat(64);
const OTHER = "b".repeat(64);

// The server-side checkout-time binding, as recorded by
// pages/api/stripe/create-payment-intent.ts when the buyer created the
// PaymentIntent.
const STORED_CONTEXT = {
  sellerPubkey: SELLER,
  orderId: "order-1",
  productId: "prod_evt_1",
  toAddress: {
    name: "Buyer Person",
    street1: "100 Buyer St",
    city: "Buyerville",
    state: "CA",
    zip: "90001",
    country: "US",
  },
};

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

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    paymentIntentId: "pi_1",
    sellerPubkey: SELLER,
    ...overrides,
  };
}

function makeRequest(body: Record<string, unknown>) {
  return { method: "POST", headers: {}, body } as any;
}

beforeEach(() => {
  jest.clearAllMocks();
  applyRateLimitMock.mockResolvedValue(true);
  isShippoOAuthConfiguredMock.mockReturnValue(true);
  getStripeConnectAccountMock.mockResolvedValue({
    stripe_account_id: "acct_123",
    onboarding_complete: true,
    charges_enabled: true,
    payouts_enabled: true,
    tax_enabled: true,
  });
  retrieveMock.mockResolvedValue({
    id: "pi_1",
    status: "succeeded",
    metadata: { sellerPubkey: SELLER, source: "cart" },
  });
  getShippingCheckoutContextMock.mockResolvedValue(STORED_CONTEXT);
  runAutoLabelPurchaseMock.mockResolvedValue({ purchased: true, labelId: 99 });
});

describe("/api/shipping/auto-purchase — happy path", () => {
  it("verifies the PaymentIntent and invokes the purchase core with the stored checkout binding", async () => {
    const res = createResponse();
    await handler(makeRequest(validBody()), res as any);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toMatchObject({ success: true, labelId: 99 });

    // The binding is looked up by the VERIFIED PaymentIntent id + seller.
    expect(getShippingCheckoutContextMock).toHaveBeenCalledWith(
      "stripe:pi_1",
      SELLER
    );

    expect(runAutoLabelPurchaseMock).toHaveBeenCalledTimes(1);
    const arg = runAutoLabelPurchaseMock.mock.calls[0][0];
    expect(arg).toMatchObject({
      sellerPubkey: SELLER,
      orderId: "order-1",
      // The claim is bound to the VERIFIED PaymentIntent id, not the client
      // orderId — this is what prevents one settled PI from being replayed.
      claimRef: "pi_1",
      productId: "prod_evt_1",
      toAddress: { street1: "100 Buyer St", zip: "90001", country: "US" },
    });
    // Single-seller charge is retrieved on the connected account.
    expect(retrieveMock).toHaveBeenCalledWith("pi_1", {
      stripeAccount: "acct_123",
    });
  });
});

describe("/api/shipping/auto-purchase — rejects unverified payments", () => {
  it("rejects a PaymentIntent that has not succeeded and never calls the core", async () => {
    retrieveMock.mockResolvedValue({
      id: "pi_1",
      status: "requires_payment_method",
      metadata: { sellerPubkey: SELLER },
    });

    const res = createResponse();
    await handler(makeRequest(validBody()), res as any);

    expect(res.jsonBody).toEqual({
      success: false,
      reason: "pi-not-succeeded",
    });
    expect(runAutoLabelPurchaseMock).not.toHaveBeenCalled();
  });

  it("rejects a PaymentIntent whose metadata does not name this seller", async () => {
    retrieveMock.mockResolvedValue({
      id: "pi_1",
      status: "succeeded",
      metadata: { sellerPubkey: OTHER },
    });

    const res = createResponse();
    await handler(makeRequest(validBody()), res as any);

    expect(res.jsonBody).toEqual({ success: false, reason: "seller-mismatch" });
    expect(runAutoLabelPurchaseMock).not.toHaveBeenCalled();
  });

  it("rejects when the PaymentIntent cannot be retrieved anywhere", async () => {
    retrieveMock.mockRejectedValue(new Error("No such payment_intent"));

    const res = createResponse();
    await handler(makeRequest(validBody()), res as any);

    expect(res.jsonBody).toEqual({ success: false, reason: "pi-not-found" });
    expect(runAutoLabelPurchaseMock).not.toHaveBeenCalled();
  });

  it("returns 400 when required fields are missing", async () => {
    const res = createResponse();
    await handler(
      makeRequest(validBody({ paymentIntentId: undefined })),
      res as any
    );
    expect(res.statusCode).toBe(400);
    expect(runAutoLabelPurchaseMock).not.toHaveBeenCalled();
  });

  it("skips silently when the shipping provider is not configured", async () => {
    isShippoOAuthConfiguredMock.mockReturnValue(false);
    const res = createResponse();
    await handler(makeRequest(validBody()), res as any);
    expect(res.jsonBody).toEqual({ success: false, skipped: true });
    expect(retrieveMock).not.toHaveBeenCalled();
    expect(runAutoLabelPurchaseMock).not.toHaveBeenCalled();
  });
});

describe("/api/shipping/auto-purchase — checkout-time binding is authoritative", () => {
  it("ignores a request body that names a different order, product, and destination", async () => {
    // The attack this endpoint must not allow: a buyer holds a settled PI for
    // a cheap-shipping checkout and POSTs an expensive destination (and a
    // different, heavier parcel profile) after the fact. The core must
    // receive the checkout-time record, never the body values.
    const res = createResponse();
    await handler(
      makeRequest(
        validBody({
          orderId: "order-ATTACKER",
          productId: "prod_evt_HEAVY",
          toAddress: {
            name: "Mule",
            street1: "1 Expensive Way",
            city: "Remote",
            state: "AK",
            zip: "99501",
            country: "US",
          },
        })
      ),
      res as any
    );

    expect(res.statusCode).toBe(200);
    expect(runAutoLabelPurchaseMock).toHaveBeenCalledTimes(1);
    const arg = runAutoLabelPurchaseMock.mock.calls[0][0];
    expect(arg.orderId).toBe("order-1");
    expect(arg.productId).toBe("prod_evt_1");
    expect(arg.toAddress).toMatchObject({
      street1: "100 Buyer St",
      zip: "90001",
    });
    // Explicitly NOT the attacker-supplied values — an echo regression must fail.
    expect(arg.orderId).not.toBe("order-ATTACKER");
    expect(arg.productId).not.toBe("prod_evt_HEAVY");
    expect(arg.toAddress.zip).not.toBe("99501");
  });

  it("fails closed when no checkout binding exists for the verified payment", async () => {
    // Legacy payment (created before binding shipped), a non-shipping
    // checkout, or a pruned record: no binding means NO automatic label.
    getShippingCheckoutContextMock.mockResolvedValue(null);

    const res = createResponse();
    await handler(makeRequest(validBody()), res as any);

    expect(res.jsonBody).toEqual({
      success: false,
      reason: "no-checkout-context",
    });
    expect(runAutoLabelPurchaseMock).not.toHaveBeenCalled();
  });

  it("fails closed when the binding lookup itself errors", async () => {
    // A DB outage must not be read as "no binding" and must never reach the
    // purchase core.
    getShippingCheckoutContextMock.mockRejectedValue(new Error("db down"));

    const res = createResponse();
    await handler(makeRequest(validBody()), res as any);

    expect(res.jsonBody).toEqual({ success: false, reason: "error" });
    expect(runAutoLabelPurchaseMock).not.toHaveBeenCalled();
  });
});

describe("/api/shipping/auto-purchase — account resolution", () => {
  it("falls back to the platform account for a multi-merchant charge", async () => {
    // This seller's products were part of a platform (multi-merchant) charge:
    // no own connected account, PI lives on the platform and lists both sellers.
    getStripeConnectAccountMock.mockResolvedValue(null);
    retrieveMock.mockResolvedValue({
      id: "pi_1",
      status: "succeeded",
      metadata: { sellerPubkey: `${SELLER},${OTHER}` },
    });

    const res = createResponse();
    await handler(makeRequest(validBody()), res as any);

    expect(res.jsonBody).toMatchObject({ success: true });
    // Retrieved on the platform account (no stripeAccount option).
    expect(retrieveMock).toHaveBeenCalledWith("pi_1");
    expect(runAutoLabelPurchaseMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the platform account when the PI is not on the connected account", async () => {
    retrieveMock
      .mockRejectedValueOnce(new Error("No such payment_intent on connected"))
      .mockResolvedValueOnce({
        id: "pi_1",
        status: "succeeded",
        metadata: { sellerPubkey: SELLER },
      });

    const res = createResponse();
    await handler(makeRequest(validBody()), res as any);

    expect(res.jsonBody).toMatchObject({ success: true });
    expect(retrieveMock).toHaveBeenNthCalledWith(1, "pi_1", {
      stripeAccount: "acct_123",
    });
    expect(retrieveMock).toHaveBeenNthCalledWith(2, "pi_1");
    expect(runAutoLabelPurchaseMock).toHaveBeenCalledTimes(1);
  });
});

describe("/api/shipping/auto-purchase — claim and binding are bound to the verified PI id, not the client value", () => {
  it("uses the Stripe-verified PaymentIntent id for the claim and the binding lookup even when the request body sends a different id", async () => {
    // The replay guard must key off the id Stripe actually returns, never the
    // client-supplied paymentIntentId — otherwise a buyer could craft a body
    // that escapes the once-per-payment claim and buy unlimited seller-billed
    // labels off one settled charge.
    retrieveMock.mockResolvedValue({
      id: "pi_VERIFIED",
      status: "succeeded",
      metadata: { sellerPubkey: SELLER, source: "cart" },
    });

    const res = createResponse();
    await handler(
      makeRequest(validBody({ paymentIntentId: "pi_CLIENT" })),
      res as any
    );

    expect(res.statusCode).toBe(200);
    // The PI is looked up using the client-supplied id...
    expect(retrieveMock).toHaveBeenCalledWith("pi_CLIENT", {
      stripeAccount: "acct_123",
    });
    // ...but the checkout binding is keyed by the id Stripe actually returned.
    expect(getShippingCheckoutContextMock).toHaveBeenCalledWith(
      "stripe:pi_VERIFIED",
      SELLER
    );
    // ...and so is the dedupe claim.
    const arg = runAutoLabelPurchaseMock.mock.calls[0][0];
    expect(arg.claimRef).toBe("pi_VERIFIED");
    // Explicitly NOT the client-supplied value — an echo regression must fail.
    expect(arg.claimRef).not.toBe("pi_CLIENT");
  });
});
