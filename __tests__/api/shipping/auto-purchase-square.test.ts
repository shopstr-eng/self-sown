/** @jest-environment node */

// Route-level coverage for the web (Square) auto-label-purchase endpoint
// (pages/api/shipping/auto-purchase-square.ts). This endpoint takes no Nostr
// proof — its authorization is a re-verified, COMPLETED Square payment retrieved
// with the SELLER's own access token. These tests pin the money-safety gates so
// a buyer can never make a seller buy a label without a real, settled payment on
// that seller's own Square account:
//   - A payment that isn't COMPLETED is rejected (no core call).
//   - A payment that can't be retrieved on the seller's account is rejected.
//   - A seller with no Square connection is rejected.
//   - The claim is bound to the VERIFIED Square payment id, not the client
//     orderId, so one settled payment can't be replayed for unlimited labels.

const applyRateLimitMock = jest.fn();
const isShippoOAuthConfiguredMock = jest.fn();
const isSquareConfiguredMock = jest.fn();
const getValidSquareAccessTokenMock = jest.fn();
const getSquarePaymentMock = jest.fn();
const getShippingCheckoutContextMock = jest.fn();
const runAutoLabelPurchaseMock = jest.fn();

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: (...args: unknown[]) => applyRateLimitMock(...args),
}));

jest.mock("@/utils/shipping/shippo-oauth", () => ({
  isShippoOAuthConfigured: (...args: unknown[]) =>
    isShippoOAuthConfiguredMock(...args),
}));

jest.mock("@/utils/square/square-config", () => ({
  isSquareConfigured: (...args: unknown[]) => isSquareConfiguredMock(...args),
}));

jest.mock("@/utils/square/square-api", () => ({
  getValidSquareAccessToken: (...args: unknown[]) =>
    getValidSquareAccessTokenMock(...args),
  getSquarePayment: (...args: unknown[]) => getSquarePaymentMock(...args),
}));

jest.mock("@/utils/db/shipping-service", () => ({
  getShippingCheckoutContext: (...args: unknown[]) =>
    getShippingCheckoutContextMock(...args),
}));

jest.mock("@/utils/shipping/auto-purchase", () => ({
  runAutoLabelPurchase: (...args: unknown[]) =>
    runAutoLabelPurchaseMock(...args),
}));

import handler from "@/pages/api/shipping/auto-purchase-square";

const SELLER = "a".repeat(64);

// The server-side checkout-time binding, as recorded by
// pages/api/square/create-payment.ts when the buyer's card was charged.
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
    squarePaymentId: "sqpmt_1",
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
  isSquareConfiguredMock.mockReturnValue(true);
  getValidSquareAccessTokenMock.mockResolvedValue({
    accessToken: "sq-token",
    locationId: "loc_1",
    locationCurrency: "USD",
    merchantId: "merch_1",
  });
  getSquarePaymentMock.mockResolvedValue({
    id: "sqpmt_1",
    status: "COMPLETED",
  });
  getShippingCheckoutContextMock.mockResolvedValue(STORED_CONTEXT);
  runAutoLabelPurchaseMock.mockResolvedValue({ purchased: true, labelId: 99 });
});

describe("/api/shipping/auto-purchase-square — happy path", () => {
  it("verifies the Square payment and invokes the purchase core", async () => {
    const res = createResponse();
    await handler(makeRequest(validBody()), res as any);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toMatchObject({ success: true, labelId: 99 });

    // Payment is retrieved with the seller's own access token (binds it to them).
    expect(getSquarePaymentMock).toHaveBeenCalledWith("sq-token", "sqpmt_1");

    // The binding is looked up by the VERIFIED Square payment id + seller.
    expect(getShippingCheckoutContextMock).toHaveBeenCalledWith(
      "square:sqpmt_1",
      SELLER
    );

    expect(runAutoLabelPurchaseMock).toHaveBeenCalledTimes(1);
    const arg = runAutoLabelPurchaseMock.mock.calls[0][0];
    expect(arg).toMatchObject({
      sellerPubkey: SELLER,
      orderId: "order-1",
      // The claim is bound to the VERIFIED Square payment id, not the client
      // orderId — this is what prevents one settled payment from being replayed.
      claimRef: "sqpmt_1",
      productId: "prod_evt_1",
      toAddress: { street1: "100 Buyer St", zip: "90001", country: "US" },
    });
  });

  it("binds the claim to the server-verified payment id, not the client-supplied one", async () => {
    // The browser asks to verify one id, but Square (queried with the seller's
    // own token) returns a DIFFERENT canonical payment id. The dedupe claim must
    // follow the trusted server value — if the endpoint echoed the client's
    // squarePaymentId, a crafted request could steer the claim key and replay a
    // settled payment for unlimited seller-billed labels.
    getSquarePaymentMock.mockResolvedValue({
      id: "sqpmt_server_verified",
      status: "COMPLETED",
    });

    const res = createResponse();
    await handler(
      makeRequest(validBody({ squarePaymentId: "sqpmt_client_claimed" })),
      res as any
    );

    expect(res.statusCode).toBe(200);
    // The lookup uses the client-supplied id (that's what the buyer references).
    expect(getSquarePaymentMock).toHaveBeenCalledWith(
      "sq-token",
      "sqpmt_client_claimed"
    );

    // The checkout binding is keyed on the VERIFIED, server-returned payment
    // id — NOT the value the browser sent...
    expect(getShippingCheckoutContextMock).toHaveBeenCalledWith(
      "square:sqpmt_server_verified",
      SELLER
    );

    expect(runAutoLabelPurchaseMock).toHaveBeenCalledTimes(1);
    const arg = runAutoLabelPurchaseMock.mock.calls[0][0];
    // ...and so is the dedupe claim.
    expect(arg.claimRef).toBe("sqpmt_server_verified");
    expect(arg.claimRef).not.toBe("sqpmt_client_claimed");
  });
});

describe("/api/shipping/auto-purchase-square — checkout-time binding is authoritative", () => {
  it("ignores a request body that names a different order, product, and destination", async () => {
    // The attack this endpoint must not allow: a buyer holds a settled payment
    // for a cheap-shipping checkout and POSTs an expensive destination (and a
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

describe("/api/shipping/auto-purchase-square — rejects unverified payments", () => {
  it("rejects a payment that is not COMPLETED and never calls the core", async () => {
    getSquarePaymentMock.mockResolvedValue({
      id: "sqpmt_1",
      status: "APPROVED",
    });

    const res = createResponse();
    await handler(makeRequest(validBody()), res as any);

    expect(res.jsonBody).toEqual({
      success: false,
      reason: "payment-not-completed",
    });
    expect(runAutoLabelPurchaseMock).not.toHaveBeenCalled();
  });

  it("rejects when the payment cannot be retrieved on the seller's account", async () => {
    getSquarePaymentMock.mockResolvedValue(null);

    const res = createResponse();
    await handler(makeRequest(validBody()), res as any);

    expect(res.jsonBody).toEqual({
      success: false,
      reason: "payment-not-found",
    });
    expect(runAutoLabelPurchaseMock).not.toHaveBeenCalled();
  });

  it("rejects when the seller has no Square connection", async () => {
    getValidSquareAccessTokenMock.mockResolvedValue(null);

    const res = createResponse();
    await handler(makeRequest(validBody()), res as any);

    expect(res.jsonBody).toEqual({ success: false, reason: "no-square" });
    expect(getSquarePaymentMock).not.toHaveBeenCalled();
    expect(runAutoLabelPurchaseMock).not.toHaveBeenCalled();
  });

  it("returns 400 when required fields are missing", async () => {
    const res = createResponse();
    await handler(
      makeRequest(validBody({ squarePaymentId: undefined })),
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
    expect(getSquarePaymentMock).not.toHaveBeenCalled();
    expect(runAutoLabelPurchaseMock).not.toHaveBeenCalled();
  });

  it("skips silently when Square is not configured", async () => {
    isSquareConfiguredMock.mockReturnValue(false);
    const res = createResponse();
    await handler(makeRequest(validBody()), res as any);
    expect(res.jsonBody).toEqual({ success: false, skipped: true });
    expect(getSquarePaymentMock).not.toHaveBeenCalled();
    expect(runAutoLabelPurchaseMock).not.toHaveBeenCalled();
  });
});
