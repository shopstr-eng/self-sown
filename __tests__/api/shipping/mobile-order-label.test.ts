/** @jest-environment node */

const applyRateLimitMock = jest.fn();
const verifyNip98RequestMock = jest.fn();
const getSellerOrderStateMock = jest.fn();
const getRatesMock = jest.fn();
const buyLabelMock = jest.fn();
const getShippoAccessTokenMock = jest.fn();
const getShippingDefaultsForPubkeyMock = jest.fn();
const rememberShipmentOwnerMock = jest.fn();
const getShipmentClaimMock = jest.fn();
const claimShipmentForPurchaseMock = jest.fn();
const releaseShipmentClaimMock = jest.fn();
const claimOutboundLabelPurchaseMock = jest.fn();
const releaseOutboundLabelClaimMock = jest.fn();
const markOutboundLabelPurchasedMock = jest.fn();
const insertShippingLabelMock = jest.fn();
const listShippingLabelsForPubkeyMock = jest.fn();
const isShippoOAuthConfiguredMock = jest.fn();
const isListedSellerMock = jest.fn();
const isPubkeyProEntitledMock = jest.fn();
const isDefinitiveShippoPurchaseFailureMock = jest.fn();

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: (...args: unknown[]) => applyRateLimitMock(...args),
}));
jest.mock("@/utils/nostr/nip98-auth", () => ({
  verifyNip98Request: (...args: unknown[]) => verifyNip98RequestMock(...args),
}));
jest.mock("@/utils/db/db-service", () => ({
  getSellerOrderState: (...args: unknown[]) => getSellerOrderStateMock(...args),
}));
jest.mock("@/utils/shipping/shippo", () => ({
  getRates: (...args: unknown[]) => getRatesMock(...args),
  buyLabel: (...args: unknown[]) => buyLabelMock(...args),
  isDefinitiveShippoPurchaseFailure: (...args: unknown[]) =>
    isDefinitiveShippoPurchaseFailureMock(...args),
}));
jest.mock("@/utils/shipping/shippo-oauth", () => ({
  isShippoOAuthConfigured: (...args: unknown[]) =>
    isShippoOAuthConfiguredMock(...args),
}));
jest.mock("@/utils/shipping/shipment-owners", () => ({
  isListedSeller: (...args: unknown[]) => isListedSellerMock(...args),
}));
jest.mock("@/utils/pro/membership", () => ({
  isPubkeyProEntitled: (...args: unknown[]) => isPubkeyProEntitledMock(...args),
}));
jest.mock("@/utils/db/shipping-service", () => ({
  getShippoAccessToken: (...args: unknown[]) =>
    getShippoAccessTokenMock(...args),
  getShippingDefaultsForPubkey: (...args: unknown[]) =>
    getShippingDefaultsForPubkeyMock(...args),
  rememberShipmentOwner: (...args: unknown[]) =>
    rememberShipmentOwnerMock(...args),
  getShipmentClaim: (...args: unknown[]) => getShipmentClaimMock(...args),
  claimShipmentForPurchase: (...args: unknown[]) =>
    claimShipmentForPurchaseMock(...args),
  releaseShipmentClaim: (...args: unknown[]) =>
    releaseShipmentClaimMock(...args),
  claimOutboundLabelPurchase: (...args: unknown[]) =>
    claimOutboundLabelPurchaseMock(...args),
  releaseOutboundLabelClaim: (...args: unknown[]) =>
    releaseOutboundLabelClaimMock(...args),
  markOutboundLabelPurchased: (...args: unknown[]) =>
    markOutboundLabelPurchasedMock(...args),
  insertShippingLabel: (...args: unknown[]) => insertShippingLabelMock(...args),
  listShippingLabelsForPubkey: (...args: unknown[]) =>
    listShippingLabelsForPubkeyMock(...args),
}));

import buyLabelHandler from "@/pages/api/shipping/buy-label";
import labelsHandler from "@/pages/api/shipping/labels";
import ratesHandler from "@/pages/api/shipping/rates";

const SELLER = "a".repeat(64);
const OTHER = "b".repeat(64);
const ORDER_ID = "order-1";

function response() {
  return {
    statusCode: 200,
    jsonBody: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.jsonBody = body;
      return this;
    },
  };
}

function request(body: Record<string, unknown>) {
  return {
    method: "POST",
    headers: { authorization: "Nostr proof" },
    url: "/api/shipping/test",
    body,
  } as any;
}

const quoteBody = {
  orderId: ORDER_ID,
  to: {
    name: "Ada",
    street1: "12 Market St",
    city: "Austin",
    state: "TX",
    postalCode: "78701",
    country: "US",
  },
  parcel: { weightOz: 16 },
};

const buyBody = {
  orderId: ORDER_ID,
  shipmentId: "ship-1",
  rateId: "rate-1",
};

beforeEach(() => {
  jest.clearAllMocks();
  applyRateLimitMock.mockResolvedValue(true);
  verifyNip98RequestMock.mockResolvedValue({ ok: true, pubkey: SELLER });
  isShippoOAuthConfiguredMock.mockReturnValue(true);
  isListedSellerMock.mockResolvedValue(true);
  isPubkeyProEntitledMock.mockResolvedValue(true);
  isDefinitiveShippoPurchaseFailureMock.mockReturnValue(false);
  getSellerOrderStateMock.mockResolvedValue({
    sellerPubkey: SELLER,
    buyerPubkey: OTHER,
    orderId: ORDER_ID,
    status: "confirmed",
    version: 1,
  });
  getShippingDefaultsForPubkeyMock.mockResolvedValue({
    fromName: "Milk Farm",
    fromStreet1: "1 Farm Rd",
    fromCity: "Austin",
    fromState: "TX",
    fromZip: "78702",
    fromCountry: "US",
    preferredCarriers: ["USPS"],
  });
  getShippoAccessTokenMock.mockResolvedValue("oauth.seller");
  getRatesMock.mockResolvedValue({
    shipmentId: "ship-1",
    rates: [{ id: "rate-1", shipmentId: "ship-1" }],
    cheapest: null,
  });
  rememberShipmentOwnerMock.mockResolvedValue(undefined);
  getShipmentClaimMock.mockResolvedValue({
    shipmentId: "ship-1",
    pubkey: SELLER,
    orderId: ORDER_ID,
    status: "owned",
  });
  claimOutboundLabelPurchaseMock.mockResolvedValue(true);
  claimShipmentForPurchaseMock.mockResolvedValue(true);
  buyLabelMock.mockResolvedValue({
    shipmentId: "ship-1",
    trackingCode: "TRACK-1",
    trackingUrl: null,
    labelUrl: "https://labels.example/1.pdf",
    labelFormat: "PDF",
    rate: 8.25,
    currency: "USD",
    carrier: "USPS",
    service: "Priority",
  });
  insertShippingLabelMock.mockResolvedValue({ id: 42 });
  listShippingLabelsForPubkeyMock.mockResolvedValue([{ id: 42 }]);
});

test("mobile label history requires NIP-98 and filters in the database", async () => {
  const req = {
    method: "GET",
    headers: { authorization: "Nostr proof" },
    url: `/api/shipping/labels?orderId=${ORDER_ID}`,
    query: { orderId: ORDER_ID },
  } as any;
  const res = response();

  await labelsHandler(req, res as any);

  expect(verifyNip98RequestMock).toHaveBeenCalledWith(req, "GET");
  expect(listShippingLabelsForPubkeyMock).toHaveBeenCalledWith(
    SELLER,
    200,
    ORDER_ID
  );
  expect(res.jsonBody).toEqual({ success: true, labels: [{ id: 42 }] });
});

describe("mobile order label quote", () => {
  test("normalizes the country name from web checkout before quoting", async () => {
    const res = response();
    await ratesHandler(
      request({
        ...quoteBody,
        to: { ...quoteBody.to, country: "United States of America" },
      }),
      res as any
    );
    expect(res.statusCode).toBe(200);
    expect(getRatesMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        to: expect.objectContaining({ country: "US" }),
      })
    );
  });

  test("binds the signed seller, confirmed order, and quoted shipment", async () => {
    const req = request(quoteBody);
    req.url = "/api/shipping/rates";
    const res = response();

    await ratesHandler(req, res as any);

    expect(verifyNip98RequestMock).toHaveBeenCalledWith(req, "POST", quoteBody);
    expect(getSellerOrderStateMock).toHaveBeenCalledWith(ORDER_ID, SELLER);
    expect(rememberShipmentOwnerMock).toHaveBeenCalledWith(
      "ship-1",
      SELLER,
      ORDER_ID
    );
    expect(res.statusCode).toBe(200);
  });

  test("rejects another seller and an unconfirmed order before Shippo", async () => {
    getSellerOrderStateMock.mockResolvedValueOnce(null).mockResolvedValueOnce({
      sellerPubkey: SELLER,
      orderId: ORDER_ID,
      status: "pending",
      version: 0,
    });

    const first = response();
    await ratesHandler(request(quoteBody), first as any);
    expect(first.statusCode).toBe(403);

    const second = response();
    await ratesHandler(request(quoteBody), second as any);
    expect(second.statusCode).toBe(409);
    expect(getRatesMock).not.toHaveBeenCalled();
  });

  test.each([
    {
      to: { ...quoteBody.to, street1: "x".repeat(257) },
      parcel: quoteBody.parcel,
    },
    {
      to: { ...quoteBody.to, country: "CA" },
      parcel: quoteBody.parcel,
    },
    {
      to: quoteBody.to,
      parcel: { weightOz: 16, widthIn: -1 },
    },
    {
      to: quoteBody.to,
      parcel: { weightOz: 1_000_001 },
    },
  ])("rejects malformed provider input before Shippo: %p", async (input) => {
    const res = response();

    await ratesHandler(request({ orderId: ORDER_ID, ...input }), res as any);

    expect(res.statusCode).toBe(400);
    expect(getRatesMock).not.toHaveBeenCalled();
  });
});

describe("mobile order label purchase", () => {
  test.each([
    { ...buyBody, shipmentId: "x".repeat(257) },
    { ...buyBody, rateId: "bad rate" },
    { ...buyBody, insuranceAmount: -1 },
    { ...buyBody, insuranceAmount: Number.POSITIVE_INFINITY },
  ])(
    "rejects invalid purchase input before authorization: %p",
    async (body) => {
      const res = response();

      await buyLabelHandler(request(body), res as any);

      expect(res.statusCode).toBe(400);
      expect(verifyNip98RequestMock).not.toHaveBeenCalled();
      expect(buyLabelMock).not.toHaveBeenCalled();
    }
  );

  test("uses order and shipment claims before one provider charge", async () => {
    const req = request(buyBody);
    req.url = "/api/shipping/buy-label";
    const res = response();

    await buyLabelHandler(req, res as any);

    expect(verifyNip98RequestMock).toHaveBeenCalledWith(req, "POST", buyBody);
    expect(getSellerOrderStateMock).toHaveBeenCalledWith(ORDER_ID, SELLER);
    expect(claimOutboundLabelPurchaseMock).toHaveBeenCalledWith(
      SELLER,
      ORDER_ID
    );
    expect(claimShipmentForPurchaseMock).toHaveBeenCalledWith(
      "ship-1",
      SELLER,
      ORDER_ID
    );
    expect(buyLabelMock).toHaveBeenCalledTimes(1);
    expect(markOutboundLabelPurchasedMock).toHaveBeenCalledWith(
      SELLER,
      ORDER_ID,
      "ship-1"
    );
    expect(res.statusCode).toBe(200);
  });

  test("rejects a shipment bound to another order", async () => {
    getShipmentClaimMock.mockResolvedValue({
      shipmentId: "ship-1",
      pubkey: SELLER,
      orderId: "order-2",
      status: "owned",
    });
    const res = response();

    await buyLabelHandler(request(buyBody), res as any);

    expect(res.statusCode).toBe(403);
    expect(claimOutboundLabelPurchaseMock).not.toHaveBeenCalled();
    expect(buyLabelMock).not.toHaveBeenCalled();
  });

  test("returns conflict when automatic purchase already claimed the order", async () => {
    claimOutboundLabelPurchaseMock.mockResolvedValue(false);
    const res = response();

    await buyLabelHandler(request(buyBody), res as any);

    expect(res.statusCode).toBe(409);
    expect(claimShipmentForPurchaseMock).not.toHaveBeenCalled();
    expect(buyLabelMock).not.toHaveBeenCalled();
  });

  test("never releases claims after Shippo charged, even if persistence fails", async () => {
    markOutboundLabelPurchasedMock.mockRejectedValue(new Error("db down"));
    insertShippingLabelMock.mockRejectedValue(new Error("db down"));
    const res = response();

    await buyLabelHandler(request(buyBody), res as any);

    expect(res.statusCode).toBe(200);
    expect(buyLabelMock).toHaveBeenCalledTimes(1);
    expect(releaseShipmentClaimMock).not.toHaveBeenCalled();
    expect(releaseOutboundLabelClaimMock).not.toHaveBeenCalled();
  });

  test("retains both claims when the provider result is uncertain", async () => {
    buyLabelMock.mockRejectedValue(new Error("Shippo timeout"));
    const res = response();

    await buyLabelHandler(request(buyBody), res as any);

    expect(res.statusCode).toBe(502);
    expect(releaseShipmentClaimMock).not.toHaveBeenCalled();
    expect(releaseOutboundLabelClaimMock).not.toHaveBeenCalled();
  });
});
