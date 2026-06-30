/** @jest-environment node */

// Money-safety coverage for the shared automatic-label-purchase core
// (utils/shipping/auto-purchase.ts) used by the card (web) and agent (MCP)
// paths. Every assertion here protects the seller from being charged for a
// label they didn't authorize or charged twice for one order:
//   - OFF (toggle false) buys nothing.
//   - Default is ON (null defaults still proceed).
//   - Non-Pro, no-Shippo, ineligible, product-mismatch all skip before charge.
//   - The per-(seller, order) claim dedups; a lost claim never charges.
//   - A pre-existing label for the order blocks a duplicate.
//   - A failed Shippo call releases the claim; a successful buy whose history
//     insert fails keeps the claim 'purchased' (never re-bought).
//   - The function never throws to its caller.

const getRatesMock = jest.fn();
const buyLabelMock = jest.fn();
const isShippoOAuthConfiguredMock = jest.fn();
const isPubkeyProEntitledMock = jest.fn();
const parseTagsMock = jest.fn();
const fetchProductByIdFromDbMock = jest.fn();
const getMcpOrderMock = jest.fn();

const claimAutoLabelPurchaseMock = jest.fn();
const releaseAutoLabelClaimMock = jest.fn();
const markAutoLabelPurchasedMock = jest.fn();
const countOutboundLabelsForOrderMock = jest.fn();
const getShippingDefaultsForPubkeyMock = jest.fn();
const getShippoAccessTokenMock = jest.fn();
const insertShippingLabelMock = jest.fn();

jest.mock("@/utils/shipping/shippo", () => ({
  getRates: (...args: unknown[]) => getRatesMock(...args),
  buyLabel: (...args: unknown[]) => buyLabelMock(...args),
}));

jest.mock("@/utils/shipping/shippo-oauth", () => ({
  isShippoOAuthConfigured: (...args: unknown[]) =>
    isShippoOAuthConfiguredMock(...args),
}));

jest.mock("@/utils/pro/membership", () => ({
  isPubkeyProEntitled: (...args: unknown[]) => isPubkeyProEntitledMock(...args),
}));

jest.mock("@/utils/parsers/product-parser-functions", () => ({
  __esModule: true,
  default: (...args: unknown[]) => parseTagsMock(...args),
}));

jest.mock("@/utils/db/db-service", () => ({
  fetchProductByIdFromDb: (...args: unknown[]) =>
    fetchProductByIdFromDbMock(...args),
}));

jest.mock("@/mcp/tools/purchase-tools", () => ({
  getMcpOrder: (...args: unknown[]) => getMcpOrderMock(...args),
}));

jest.mock("@/utils/db/shipping-service", () => ({
  claimAutoLabelPurchase: (...args: unknown[]) =>
    claimAutoLabelPurchaseMock(...args),
  releaseAutoLabelClaim: (...args: unknown[]) =>
    releaseAutoLabelClaimMock(...args),
  markAutoLabelPurchased: (...args: unknown[]) =>
    markAutoLabelPurchasedMock(...args),
  countOutboundLabelsForOrder: (...args: unknown[]) =>
    countOutboundLabelsForOrderMock(...args),
  getShippingDefaultsForPubkey: (...args: unknown[]) =>
    getShippingDefaultsForPubkeyMock(...args),
  getShippoAccessToken: (...args: unknown[]) =>
    getShippoAccessTokenMock(...args),
  insertShippingLabel: (...args: unknown[]) => insertShippingLabelMock(...args),
}));

import {
  runAutoLabelPurchase,
  autoPurchaseForMcpOrder,
} from "@/utils/shipping/auto-purchase";

const SELLER = "a".repeat(64);
const OTHER = "b".repeat(64);

const PRODUCT_EVENT = {
  id: "prod_evt_1",
  pubkey: SELLER,
  created_at: 1,
  kind: 30402,
  tags: [] as string[][],
  content: "",
  sig: "",
};

const TO_ADDRESS = {
  name: "Buyer Person",
  street1: "100 Buyer St",
  city: "Buyerville",
  state: "CA",
  zip: "90001",
  country: "US",
};

function baseArgs(overrides: Record<string, unknown> = {}) {
  return {
    sellerPubkey: SELLER,
    orderId: "order-1",
    productEvent: PRODUCT_EVENT,
    toAddress: { ...TO_ADDRESS },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();

  isShippoOAuthConfiguredMock.mockReturnValue(true);
  getShippingDefaultsForPubkeyMock.mockResolvedValue({
    autoPurchaseLabels: true,
    preferredCarriers: ["USPS"],
  });
  isPubkeyProEntitledMock.mockResolvedValue(true);
  getShippoAccessTokenMock.mockResolvedValue("oauth.seller-token");
  parseTagsMock.mockReturnValue({
    shipFromZip: "10001",
    shipFromCountry: "US",
    packageWeightOz: 16,
    packageLengthIn: 6,
    packageWidthIn: 4,
    packageHeightIn: 2,
  });
  countOutboundLabelsForOrderMock.mockResolvedValue(0);
  claimAutoLabelPurchaseMock.mockResolvedValue(true);
  getRatesMock.mockResolvedValue({
    shipmentId: "shp_1",
    rates: [{ id: "rate_1" }],
    cheapest: { id: "rate_1", carrier: "USPS", amount: 7.5 },
  });
  buyLabelMock.mockResolvedValue({
    shipmentId: "shp_1",
    trackingCode: "TRK123",
    trackingUrl: "https://track/123",
    labelUrl: "https://label/123.pdf",
    labelFormat: "PDF",
    rate: 7.5,
    currency: "USD",
    carrier: "USPS",
    service: "Priority",
  });
  insertShippingLabelMock.mockResolvedValue({ id: 99 });
  markAutoLabelPurchasedMock.mockResolvedValue(undefined);
  releaseAutoLabelClaimMock.mockResolvedValue(undefined);
  fetchProductByIdFromDbMock.mockResolvedValue(PRODUCT_EVENT);
});

describe("runAutoLabelPurchase — happy path", () => {
  it("claims, buys the cheapest label on the seller's account, and records it", async () => {
    const result = await runAutoLabelPurchase(baseArgs());

    expect(result).toMatchObject({ purchased: true, labelId: 99 });
    expect(claimAutoLabelPurchaseMock).toHaveBeenCalledTimes(1);
    expect(getRatesMock).toHaveBeenCalledTimes(1);
    expect(buyLabelMock).toHaveBeenCalledTimes(1);
    // Bought on the seller's own Shippo token, for the cheapest rate.
    expect(buyLabelMock).toHaveBeenCalledWith("oauth.seller-token", {
      shipmentId: "shp_1",
      rateId: "rate_1",
    });
    expect(insertShippingLabelMock).toHaveBeenCalledTimes(1);
    expect(markAutoLabelPurchasedMock).toHaveBeenCalledWith(
      expect.any(String),
      "shp_1"
    );
    // A successful purchase never releases the claim.
    expect(releaseAutoLabelClaimMock).not.toHaveBeenCalled();
  });

  it("uses the same (seller, order) claim key both times so it is dedupable", async () => {
    await runAutoLabelPurchase(baseArgs());
    const claimKey = claimAutoLabelPurchaseMock.mock.calls[0][0];
    const purchasedKey = markAutoLabelPurchasedMock.mock.calls[0][0];
    expect(purchasedKey).toBe(claimKey);
    expect(typeof claimKey).toBe("string");
  });
});

describe("runAutoLabelPurchase — toggle (default ON)", () => {
  it("skips entirely when the seller turned the toggle OFF", async () => {
    getShippingDefaultsForPubkeyMock.mockResolvedValue({
      autoPurchaseLabels: false,
      preferredCarriers: ["USPS"],
    });

    const result = await runAutoLabelPurchase(baseArgs());

    expect(result).toEqual({ purchased: false, reason: "disabled" });
    expect(claimAutoLabelPurchaseMock).not.toHaveBeenCalled();
    expect(getRatesMock).not.toHaveBeenCalled();
    expect(buyLabelMock).not.toHaveBeenCalled();
  });

  it("proceeds (default ON) when the seller has no defaults row yet", async () => {
    getShippingDefaultsForPubkeyMock.mockResolvedValue(null);

    const result = await runAutoLabelPurchase(baseArgs());

    expect(result.purchased).toBe(true);
    // Falls back to USPS when there are no preferred carriers.
    expect(getRatesMock.mock.calls[0][1].carriers).toEqual(["USPS"]);
  });
});

describe("runAutoLabelPurchase — gates that prevent any charge", () => {
  it("skips a non-Pro seller", async () => {
    isPubkeyProEntitledMock.mockResolvedValue(false);
    const result = await runAutoLabelPurchase(baseArgs());
    expect(result).toEqual({ purchased: false, reason: "not-pro" });
    expect(claimAutoLabelPurchaseMock).not.toHaveBeenCalled();
    expect(buyLabelMock).not.toHaveBeenCalled();
  });

  it("skips when the seller has not connected Shippo", async () => {
    getShippoAccessTokenMock.mockResolvedValue(null);
    const result = await runAutoLabelPurchase(baseArgs());
    expect(result).toEqual({ purchased: false, reason: "no-shippo" });
    expect(buyLabelMock).not.toHaveBeenCalled();
  });

  it("skips a non-US destination", async () => {
    const result = await runAutoLabelPurchase(
      baseArgs({ toAddress: { ...TO_ADDRESS, country: "CA" } })
    );
    expect(result).toEqual({ purchased: false, reason: "ineligible" });
    expect(claimAutoLabelPurchaseMock).not.toHaveBeenCalled();
    expect(buyLabelMock).not.toHaveBeenCalled();
  });

  it("skips when the parcel has no positive weight", async () => {
    parseTagsMock.mockReturnValue({ shipFromZip: "10001", packageWeightOz: 0 });
    const result = await runAutoLabelPurchase(baseArgs());
    expect(result).toEqual({ purchased: false, reason: "ineligible" });
    expect(buyLabelMock).not.toHaveBeenCalled();
  });

  it("skips when the ship-from ZIP is missing", async () => {
    parseTagsMock.mockReturnValue({ packageWeightOz: 16 });
    const result = await runAutoLabelPurchase(baseArgs());
    expect(result).toEqual({ purchased: false, reason: "ineligible" });
    expect(buyLabelMock).not.toHaveBeenCalled();
  });

  it("skips when the product does not belong to the charged seller", async () => {
    const result = await runAutoLabelPurchase(
      baseArgs({ productEvent: { ...PRODUCT_EVENT, pubkey: OTHER } })
    );
    expect(result).toEqual({ purchased: false, reason: "ineligible" });
    expect(buyLabelMock).not.toHaveBeenCalled();
  });

  it("skips when an outbound label already exists for this order", async () => {
    countOutboundLabelsForOrderMock.mockResolvedValue(1);
    const result = await runAutoLabelPurchase(baseArgs());
    expect(result).toEqual({ purchased: false, reason: "already-bought" });
    expect(claimAutoLabelPurchaseMock).not.toHaveBeenCalled();
    expect(buyLabelMock).not.toHaveBeenCalled();
  });

  it("skips when the provider is not configured", async () => {
    isShippoOAuthConfiguredMock.mockReturnValue(false);
    const result = await runAutoLabelPurchase(baseArgs());
    expect(result).toEqual({
      purchased: false,
      reason: "provider-unconfigured",
    });
    expect(buyLabelMock).not.toHaveBeenCalled();
  });
});

describe("runAutoLabelPurchase — claim dedup + failure handling", () => {
  it("does not charge when the claim is lost to a concurrent caller", async () => {
    claimAutoLabelPurchaseMock.mockResolvedValue(false);
    const result = await runAutoLabelPurchase(baseArgs());
    expect(result).toEqual({ purchased: false, reason: "claimed-by-other" });
    expect(getRatesMock).not.toHaveBeenCalled();
    expect(buyLabelMock).not.toHaveBeenCalled();
  });

  it("releases the claim and does not buy when there is no rate", async () => {
    getRatesMock.mockResolvedValue({
      shipmentId: "shp_1",
      rates: [],
      cheapest: null,
    });
    const result = await runAutoLabelPurchase(baseArgs());
    expect(result).toEqual({ purchased: false, reason: "no-rates" });
    expect(buyLabelMock).not.toHaveBeenCalled();
    expect(releaseAutoLabelClaimMock).toHaveBeenCalledTimes(1);
  });

  it("releases the claim when the Shippo purchase throws (so a retry can work)", async () => {
    buyLabelMock.mockRejectedValue(new Error("Shippo timeout"));
    const result = await runAutoLabelPurchase(baseArgs());
    expect(result).toEqual({ purchased: false, reason: "error" });
    expect(releaseAutoLabelClaimMock).toHaveBeenCalledTimes(1);
    expect(markAutoLabelPurchasedMock).not.toHaveBeenCalled();
  });

  it("keeps the claim 'purchased' (never released) when the label bought but history insert fails", async () => {
    insertShippingLabelMock.mockRejectedValue(new Error("db down"));
    const result = await runAutoLabelPurchase(baseArgs());
    // The seller WAS charged, so we report success and never release the claim.
    expect(result.purchased).toBe(true);
    expect(markAutoLabelPurchasedMock).toHaveBeenCalledTimes(1);
    expect(releaseAutoLabelClaimMock).not.toHaveBeenCalled();
  });

  it("never throws — a defaults lookup failure resolves to a benign error result", async () => {
    getShippingDefaultsForPubkeyMock.mockRejectedValue(new Error("db down"));
    const result = await runAutoLabelPurchase(baseArgs());
    expect(result).toEqual({ purchased: false, reason: "error" });
    expect(buyLabelMock).not.toHaveBeenCalled();
  });
});

describe("runAutoLabelPurchase — Stripe-bound claimRef dedup (web replay protection)", () => {
  it("buys at most once per claimRef even when the client orderId differs each call", async () => {
    // Simulate the atomic DB claim keyed by the claim-key string.
    const claimed = new Set<string>();
    claimAutoLabelPurchaseMock.mockImplementation(async (key: string) => {
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    });

    // First web POST for a settled PaymentIntent.
    const r1 = await runAutoLabelPurchase(
      baseArgs({ orderId: "client-uuid-1", claimRef: "pi_replay" })
    );
    expect(r1.purchased).toBe(true);

    // Replay with a DIFFERENT client orderId but the SAME PaymentIntent: the
    // order-based pre-check passes (new orderId) but the Stripe-bound claim
    // blocks it, so the seller is never charged a second time.
    const r2 = await runAutoLabelPurchase(
      baseArgs({ orderId: "client-uuid-2", claimRef: "pi_replay" })
    );
    expect(r2).toEqual({ purchased: false, reason: "claimed-by-other" });

    expect(buyLabelMock).toHaveBeenCalledTimes(1);
    // Both calls resolved to the same Stripe-bound claim key.
    expect(claimAutoLabelPurchaseMock.mock.calls[0][0]).toBe(
      claimAutoLabelPurchaseMock.mock.calls[1][0]
    );
  });

  it("MCP path (no claimRef) keys the claim on the server-side orderId", async () => {
    await runAutoLabelPurchase(baseArgs({ orderId: "mcp-order-9" }));
    expect(claimAutoLabelPurchaseMock.mock.calls[0][0]).toContain(
      "mcp-order-9"
    );
  });
});

describe("autoPurchaseForMcpOrder", () => {
  const PAID_ORDER = {
    order_id: "order-mcp-1",
    seller_pubkey: SELLER,
    product_id: "prod_evt_1",
    payment_status: "paid",
    buyer_email: "buyer@example.com",
    shipping_address: {
      name: "Buyer Person",
      address: "100 Buyer St",
      unit: "4B",
      city: "Buyerville",
      stateProvince: "CA",
      postalCode: "90001",
      country: "US",
    },
  };

  it("buys a label for a PAID agent order using the normalized address", async () => {
    getMcpOrderMock.mockResolvedValue(PAID_ORDER);
    const result = await autoPurchaseForMcpOrder("order-mcp-1");
    expect(result.purchased).toBe(true);
    expect(buyLabelMock).toHaveBeenCalledTimes(1);
    // The stored {address, unit, stateProvince, postalCode} mapped to the
    // Shippo {street1, street2, state, zip} shape.
    const toArg = getRatesMock.mock.calls[0][1].to;
    expect(toArg).toMatchObject({
      street1: "100 Buyer St",
      street2: "4B",
      state: "CA",
      zip: "90001",
      country: "US",
    });
  });

  it("does nothing for an unpaid order", async () => {
    getMcpOrderMock.mockResolvedValue({
      ...PAID_ORDER,
      payment_status: "unpaid",
    });
    const result = await autoPurchaseForMcpOrder("order-mcp-1");
    expect(result.purchased).toBe(false);
    expect(buyLabelMock).not.toHaveBeenCalled();
  });

  it("never throws when the order cannot be loaded", async () => {
    getMcpOrderMock.mockRejectedValue(new Error("db down"));
    const result = await autoPurchaseForMcpOrder("order-mcp-1");
    expect(result).toEqual({ purchased: false, reason: "error" });
  });
});
