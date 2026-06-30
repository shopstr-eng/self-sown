/** @jest-environment node */

// Route-level coverage for the web (Stripe) auto-label-purchase endpoint
// (pages/api/shipping/auto-purchase.ts). This endpoint takes no Nostr proof —
// its authorization is a re-verified, settled PaymentIntent. These tests pin
// the money-safety gates so a buyer can never make a seller buy a label without
// a real payment that names that seller:
//   - A PaymentIntent that isn't `succeeded` is rejected (no core call).
//   - A PaymentIntent whose metadata doesn't name this seller is rejected.
//   - A missing / unretrievable PaymentIntent is rejected.
//   - Single-seller charges are looked up on the connected account, with a
//     platform-account fallback for multi-merchant charges.
//   - Only a verified payment reaches the shared purchase core.

const applyRateLimitMock = jest.fn();
const isShippoOAuthConfiguredMock = jest.fn();
const getStripeConnectAccountMock = jest.fn();
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

jest.mock("@/utils/shipping/auto-purchase", () => ({
  runAutoLabelPurchase: (...args: unknown[]) =>
    runAutoLabelPurchaseMock(...args),
}));

import handler from "@/pages/api/shipping/auto-purchase";

const SELLER = "a".repeat(64);
const OTHER = "b".repeat(64);

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
    orderId: "order-1",
    sellerPubkey: SELLER,
    productId: "prod_evt_1",
    toAddress: {
      name: "Buyer Person",
      street1: "100 Buyer St",
      city: "Buyerville",
      state: "CA",
      zip: "90001",
      country: "US",
    },
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
  runAutoLabelPurchaseMock.mockResolvedValue({ purchased: true, labelId: 99 });
});

describe("/api/shipping/auto-purchase — happy path", () => {
  it("verifies the PaymentIntent and invokes the purchase core", async () => {
    const res = createResponse();
    await handler(makeRequest(validBody()), res as any);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toMatchObject({ success: true, labelId: 99 });

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
