/** @jest-environment node */

// Money-safety coverage for the shared automatic-label-purchase core
// (utils/shipping/auto-purchase.ts) used by the card (web) and agent (MCP)
// paths. Every assertion here protects the seller from being charged for a
// label they didn't authorize or charged twice for one order:
//   - OFF (toggle false) buys nothing.
//   - Default is ON (null defaults still proceed).
//   - Non-Pro, no-Shippo, ineligible, product-mismatch all skip before charge.
//   - The per-(seller, order) purchase coordinator dedups concurrent attempts.
//   - A pre-existing label for the order blocks a duplicate.
//   - The function never throws to its caller.

const getRatesMock = jest.fn();
const purchaseOutboundLabelMock = jest.fn();
const isShippoOAuthConfiguredMock = jest.fn();
const isPubkeyProEntitledMock = jest.fn();
const parseTagsMock = jest.fn();
const fetchProductByIdFromDbMock = jest.fn();
const getMcpOrderMock = jest.fn();

const countOutboundLabelsForOrderMock = jest.fn();
const getShippingDefaultsForPubkeyMock = jest.fn();
const getShippoAccessTokenMock = jest.fn();

jest.mock("@/utils/shipping/shippo", () => ({
  getRates: (...args: unknown[]) => getRatesMock(...args),
}));

jest.mock("@/utils/shipping/outbound-label-purchase", () => ({
  purchaseOutboundLabel: (...args: unknown[]) =>
    purchaseOutboundLabelMock(...args),
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
  countOutboundLabelsForOrder: (...args: unknown[]) =>
    countOutboundLabelsForOrderMock(...args),
  getShippingDefaultsForPubkey: (...args: unknown[]) =>
    getShippingDefaultsForPubkeyMock(...args),
  getShippoAccessToken: (...args: unknown[]) =>
    getShippoAccessTokenMock(...args),
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
    fromName: "Milk Farm",
    fromStreet1: "1 Farm Road",
    fromCity: "Austin",
    fromState: "TX",
    fromZip: "78701",
    fromCountry: "US",
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
  getRatesMock.mockResolvedValue({
    shipmentId: "shp_1",
    rates: [{ id: "rate_1" }],
    cheapest: { id: "rate_1", carrier: "USPS", amount: 7.5 },
  });
  purchaseOutboundLabelMock.mockResolvedValue({
    status: "purchased",
    labelId: 99,
    label: { shipmentId: "shp_1" },
  });
  fetchProductByIdFromDbMock.mockResolvedValue(PRODUCT_EVENT);
});

describe("runAutoLabelPurchase — happy path", () => {
  it("claims, buys the cheapest label on the seller's account, and records it", async () => {
    const result = await runAutoLabelPurchase(baseArgs());

    expect(result).toMatchObject({ purchased: true, labelId: 99 });
    expect(getRatesMock).toHaveBeenCalledTimes(1);
    expect(purchaseOutboundLabelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "oauth.seller-token",
        sellerPubkey: SELLER,
        orderId: "order-1",
        shipmentId: "shp_1",
        rateId: "rate_1",
      })
    );
    expect(getRatesMock.mock.calls[0][1].from).toMatchObject({
      name: "Milk Farm",
      street1: "1 Farm Road",
      city: "Austin",
      state: "TX",
      zip: "78701",
      country: "US",
    });
  });

  it("binds the purchase claim to the seller and order", async () => {
    await runAutoLabelPurchase(baseArgs());
    const claimKey = purchaseOutboundLabelMock.mock.calls[0][0].paymentRef;
    expect(typeof claimKey).toBe("string");
    expect(claimKey).toContain(SELLER);
    expect(claimKey).toContain("order-1");
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
    expect(purchaseOutboundLabelMock).not.toHaveBeenCalled();
    expect(getRatesMock).not.toHaveBeenCalled();
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
    expect(purchaseOutboundLabelMock).not.toHaveBeenCalled();
  });

  it("skips when the seller has not connected Shippo", async () => {
    getShippoAccessTokenMock.mockResolvedValue(null);
    const result = await runAutoLabelPurchase(baseArgs());
    expect(result).toEqual({ purchased: false, reason: "no-shippo" });
    expect(purchaseOutboundLabelMock).not.toHaveBeenCalled();
  });

  it("skips a non-US destination", async () => {
    const result = await runAutoLabelPurchase(
      baseArgs({ toAddress: { ...TO_ADDRESS, country: "CA" } })
    );
    expect(result).toEqual({ purchased: false, reason: "ineligible" });
    expect(purchaseOutboundLabelMock).not.toHaveBeenCalled();
  });

  it("skips when the parcel has no positive weight", async () => {
    parseTagsMock.mockReturnValue({ shipFromZip: "10001", packageWeightOz: 0 });
    const result = await runAutoLabelPurchase(baseArgs());
    expect(result).toEqual({ purchased: false, reason: "ineligible" });
    expect(purchaseOutboundLabelMock).not.toHaveBeenCalled();
  });

  it("skips when the ship-from ZIP is missing from defaults and listing", async () => {
    getShippingDefaultsForPubkeyMock.mockResolvedValue({
      autoPurchaseLabels: true,
      preferredCarriers: ["USPS"],
    });
    parseTagsMock.mockReturnValue({ packageWeightOz: 16 });
    const result = await runAutoLabelPurchase(baseArgs());
    expect(result).toEqual({ purchased: false, reason: "ineligible" });
    expect(purchaseOutboundLabelMock).not.toHaveBeenCalled();
  });

  it("skips when the product does not belong to the charged seller", async () => {
    const result = await runAutoLabelPurchase(
      baseArgs({ productEvent: { ...PRODUCT_EVENT, pubkey: OTHER } })
    );
    expect(result).toEqual({ purchased: false, reason: "ineligible" });
    expect(purchaseOutboundLabelMock).not.toHaveBeenCalled();
  });

  it("skips when an outbound label already exists for this order", async () => {
    countOutboundLabelsForOrderMock.mockResolvedValue(1);
    const result = await runAutoLabelPurchase(baseArgs());
    expect(result).toEqual({ purchased: false, reason: "already-bought" });
    expect(purchaseOutboundLabelMock).not.toHaveBeenCalled();
  });

  it("skips when the provider is not configured", async () => {
    isShippoOAuthConfiguredMock.mockReturnValue(false);
    const result = await runAutoLabelPurchase(baseArgs());
    expect(result).toEqual({
      purchased: false,
      reason: "provider-unconfigured",
    });
    expect(purchaseOutboundLabelMock).not.toHaveBeenCalled();
  });
});

describe("runAutoLabelPurchase — claim dedup + failure handling", () => {
  it("does not charge when the claim is lost to a concurrent caller", async () => {
    purchaseOutboundLabelMock.mockResolvedValue({
      status: "order-already-claimed",
    });
    const result = await runAutoLabelPurchase(baseArgs());
    expect(result).toEqual({ purchased: false, reason: "claimed-by-other" });
    expect(purchaseOutboundLabelMock).toHaveBeenCalledTimes(1);
  });

  it("does not enter the purchase coordinator when there is no rate", async () => {
    getRatesMock.mockResolvedValue({
      shipmentId: "shp_1",
      rates: [],
      cheapest: null,
    });
    const result = await runAutoLabelPurchase(baseArgs());
    expect(result).toEqual({ purchased: false, reason: "no-rates" });
    expect(purchaseOutboundLabelMock).not.toHaveBeenCalled();
  });

  it("maps an uncertain provider outcome to a benign error result", async () => {
    purchaseOutboundLabelMock.mockResolvedValue({ status: "uncertain" });
    const result = await runAutoLabelPurchase(baseArgs());
    expect(result).toEqual({ purchased: false, reason: "error" });
  });

  it("never throws when the purchase coordinator rejects", async () => {
    purchaseOutboundLabelMock.mockRejectedValue(new Error("Invalid rate"));

    const result = await runAutoLabelPurchase(baseArgs());

    expect(result).toEqual({ purchased: false, reason: "error" });
  });

  it("never throws — a defaults lookup failure resolves to a benign error result", async () => {
    getShippingDefaultsForPubkeyMock.mockRejectedValue(new Error("db down"));
    const result = await runAutoLabelPurchase(baseArgs());
    expect(result).toEqual({ purchased: false, reason: "error" });
    expect(purchaseOutboundLabelMock).not.toHaveBeenCalled();
  });
});

describe("runAutoLabelPurchase — Stripe-bound claimRef dedup (web replay protection)", () => {
  it("buys at most once per claimRef even when the client orderId differs each call", async () => {
    // Simulate the purchase coordinator's atomic payment-reference claim.
    const claimed = new Set<string>();
    purchaseOutboundLabelMock.mockImplementation(async ({ paymentRef }) => {
      const key = String(paymentRef);
      if (claimed.has(key)) return { status: "order-already-claimed" };
      claimed.add(key);
      return { status: "purchased", labelId: 99, label: {} };
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

    // Both calls resolved to the same Stripe-bound claim key.
    expect(purchaseOutboundLabelMock.mock.calls[0][0].paymentRef).toBe(
      purchaseOutboundLabelMock.mock.calls[1][0].paymentRef
    );
  });

  it("MCP path (no claimRef) keys the claim on the server-side orderId", async () => {
    await runAutoLabelPurchase(baseArgs({ orderId: "mcp-order-9" }));
    expect(purchaseOutboundLabelMock.mock.calls[0][0].paymentRef).toContain(
      "mcp-order-9"
    );
  });

  it("Square replay: one settled payment id buys at most one label across fresh orderIds", async () => {
    // Model the coordinator's durable payment-reference deduplication.
    const claimed = new Set<string>();
    purchaseOutboundLabelMock.mockImplementation(async ({ paymentRef }) => {
      const key = String(paymentRef);
      if (claimed.has(key)) return { status: "order-already-claimed" };
      claimed.add(key);
      return { status: "purchased", labelId: 99, label: {} };
    });

    const SQUARE_PAYMENT_ID = "sqpmt_replay_xyz";

    // First POST from the buyer's browser after a verified COMPLETED Square
    // payment. The route passes claimRef = the verified Square payment id.
    const r1 = await runAutoLabelPurchase(
      baseArgs({ orderId: "client-uuid-A", claimRef: SQUARE_PAYMENT_ID })
    );
    expect(r1.purchased).toBe(true);

    // Replays of the SAME settled payment with a fresh client orderId each time
    // (the orderId is generated in the browser, so an attacker controls it).
    const r2 = await runAutoLabelPurchase(
      baseArgs({ orderId: "client-uuid-B", claimRef: SQUARE_PAYMENT_ID })
    );
    const r3 = await runAutoLabelPurchase(
      baseArgs({ orderId: "client-uuid-C", claimRef: SQUARE_PAYMENT_ID })
    );
    expect(r2).toEqual({ purchased: false, reason: "claimed-by-other" });
    expect(r3).toEqual({ purchased: false, reason: "claimed-by-other" });

    // Every attempt resolved to the SAME claim key, and that key is bound to the
    // Square payment id — NOT to any of the client-supplied orderIds. If a
    // regression keyed the claim on orderId, these three keys would differ and
    // each replay would buy another label.
    const keys = purchaseOutboundLabelMock.mock.calls.map(
      (call) => call[0].paymentRef
    );
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toContain(SQUARE_PAYMENT_ID);
    expect(keys[0]).not.toContain("client-uuid-A");
    expect(keys[0]).not.toContain("client-uuid-B");
    expect(keys[0]).not.toContain("client-uuid-C");
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
    expect(purchaseOutboundLabelMock).toHaveBeenCalledTimes(1);
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
    expect(purchaseOutboundLabelMock).not.toHaveBeenCalled();
  });

  it("never throws when the order cannot be loaded", async () => {
    getMcpOrderMock.mockRejectedValue(new Error("db down"));
    const result = await autoPurchaseForMcpOrder("order-mcp-1");
    expect(result).toEqual({ purchased: false, reason: "error" });
  });
});
