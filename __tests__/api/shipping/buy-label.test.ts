/**
 * @jest-environment node
 *
 * Regression coverage for duplicate outbound-label protection.
 *
 * Outbound labels are bought against a `shipmentId` that was previously quoted
 * via /api/shipping/rates (which records the owning seller as an 'owned' row).
 * The handler claims that shipment via the same atomic DB guard as return
 * labels, flipping the row 'owned' -> 'purchased', so a double-click / retry
 * can never buy (and charge the seller for) the same shipment twice.
 *
 * These tests pin two behaviours that directly protect seller money:
 *   1. Two identical requests => exactly one purchase, deterministic 409 on the
 *      second.
 *   2. A failed purchase releases the claim so the seller can retry.
 */

const MCP_SIGNED_EVENT_HEADER = "x-mcp-signed-event";
const MCP_REQUEST_PROOF_KIND = 27235;

const applyRateLimitMock = jest.fn();
const buyLabelMock = jest.fn();
const isShippoOAuthConfiguredMock = jest.fn();
const isListedSellerMock = jest.fn();
const isMcpRequestProofFreshMock = jest.fn();
const parseSignedEventHeaderMock = jest.fn();
const matchesMcpRequestProofMock = jest.fn();
const buildShippingBuyLabelProofMock = jest.fn();
const verifyEventMock = jest.fn();
const isPubkeyProEntitledMock = jest.fn();

const claimShipmentForPurchaseMock = jest.fn();
const releaseShipmentClaimMock = jest.fn();
const getShipmentOwnerMock = jest.fn();
const getShippoAccessTokenMock = jest.fn();
const insertShippingLabelMock = jest.fn();

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: (...args: unknown[]) => applyRateLimitMock(...args),
}));

jest.mock("@/utils/shipping/shippo", () => ({
  buyLabel: (...args: unknown[]) => buyLabelMock(...args),
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

jest.mock("nostr-tools", () => ({
  verifyEvent: (...args: unknown[]) => verifyEventMock(...args),
}));

jest.mock("@/utils/mcp/request-proof", () => ({
  MCP_SIGNED_EVENT_HEADER: "x-mcp-signed-event",
  MCP_REQUEST_PROOF_KIND: 27235,
  isMcpRequestProofFresh: (...args: unknown[]) =>
    isMcpRequestProofFreshMock(...args),
  parseSignedEventHeader: (...args: unknown[]) =>
    parseSignedEventHeaderMock(...args),
  matchesMcpRequestProof: (...args: unknown[]) =>
    matchesMcpRequestProofMock(...args),
  buildShippingBuyLabelProof: (...args: unknown[]) =>
    buildShippingBuyLabelProofMock(...args),
}));

jest.mock("@/utils/db/shipping-service", () => ({
  claimShipmentForPurchase: (...args: unknown[]) =>
    claimShipmentForPurchaseMock(...args),
  releaseShipmentClaim: (...args: unknown[]) =>
    releaseShipmentClaimMock(...args),
  getShipmentOwner: (...args: unknown[]) => getShipmentOwnerMock(...args),
  getShippoAccessToken: (...args: unknown[]) =>
    getShippoAccessTokenMock(...args),
  insertShippingLabel: (...args: unknown[]) => insertShippingLabelMock(...args),
}));

import handler from "@/pages/api/shipping/buy-label";

const SELLER_PUBKEY = "seller-pubkey-abc";
const SHIPMENT_ID = "shp_outbound_123";
const RATE_ID = "rate_456";

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

function makeRequest(body: Record<string, unknown>) {
  return {
    method: "POST",
    headers: { [MCP_SIGNED_EVENT_HEADER]: "signed-event-header" },
    body,
  } as any;
}

// A complete, valid outbound buy-label body.
function validBody(overrides: Record<string, unknown> = {}) {
  return {
    shipmentId: SHIPMENT_ID,
    rateId: RATE_ID,
    orderId: "order-123",
    fromSummary: "Seller Shop, NY",
    toSummary: "Buyer Person, CA",
    parcelSummary: "16oz box",
    ...overrides,
  };
}

// Simulates the atomic DB claim guard for outbound labels. A 'rates' quote has
// already recorded the shipment as 'owned'; claimShipmentForPurchase flips it to
// 'purchased'. A second claim for the same shipment fails until
// releaseShipmentClaim reverts the row back to 'owned'.
function makeClaimStore() {
  const rows = new Map<string, "owned" | "purchased">();
  // The shipment was quoted via /rates first, so it starts as 'owned'.
  rows.set(SHIPMENT_ID, "owned");
  return {
    rows,
    claim: jest.fn(async (shipmentId: string) => {
      const status = rows.get(shipmentId);
      if (status === "purchased") return false;
      rows.set(shipmentId, "purchased");
      return true;
    }),
    release: jest.fn(async (shipmentId: string) => {
      if (rows.get(shipmentId) === "purchased") rows.set(shipmentId, "owned");
    }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();

  applyRateLimitMock.mockReturnValue(true);
  isShippoOAuthConfiguredMock.mockReturnValue(true);
  verifyEventMock.mockReturnValue(true);
  isMcpRequestProofFreshMock.mockReturnValue(true);
  matchesMcpRequestProofMock.mockReturnValue(true);
  buildShippingBuyLabelProofMock.mockReturnValue({
    action: "shipping_buy_label",
  });
  parseSignedEventHeaderMock.mockReturnValue({
    kind: MCP_REQUEST_PROOF_KIND,
    pubkey: SELLER_PUBKEY,
    tags: [["path", "/api/shipping/buy-label"]],
  });

  isListedSellerMock.mockResolvedValue(true);
  isPubkeyProEntitledMock.mockResolvedValue(true);
  getShipmentOwnerMock.mockResolvedValue(SELLER_PUBKEY);
  getShippoAccessTokenMock.mockResolvedValue("oauth.seller-token");
  insertShippingLabelMock.mockResolvedValue({ id: 42 });
  buyLabelMock.mockResolvedValue({
    shipmentId: SHIPMENT_ID,
    trackingCode: "TRK123",
    trackingUrl: "https://track/123",
    labelUrl: "https://label/123.pdf",
    labelFormat: "PDF",
    rate: 7.5,
    currency: "USD",
    carrier: "USPS",
    service: "Priority",
  });
});

describe("/api/shipping/buy-label duplicate protection", () => {
  it("buys exactly one label and returns a deterministic 409 on the duplicate", async () => {
    const store = makeClaimStore();
    claimShipmentForPurchaseMock.mockImplementation(store.claim);
    releaseShipmentClaimMock.mockImplementation(store.release);

    // First identical request: succeeds.
    const res1 = createResponse();
    await handler(makeRequest(validBody()), res1 as any);

    expect(res1.statusCode).toBe(200);
    expect(res1.jsonBody).toMatchObject({ success: true, id: 42 });
    expect(buyLabelMock).toHaveBeenCalledTimes(1);

    // Second identical request: blocked by the claim, no second purchase.
    const res2 = createResponse();
    await handler(makeRequest(validBody()), res2 as any);

    expect(res2.statusCode).toBe(409);
    expect(res2.jsonBody).toEqual({
      error: "Shipment label already purchased",
    });

    // The seller is charged exactly once.
    expect(buyLabelMock).toHaveBeenCalledTimes(1);

    // Both requests claimed the same shipment id, which is now 'purchased'.
    const id1 = claimShipmentForPurchaseMock.mock.calls[0][0];
    const id2 = claimShipmentForPurchaseMock.mock.calls[1][0];
    expect(id2).toBe(id1);
    expect(id1).toBe(SHIPMENT_ID);
    expect(store.rows.get(SHIPMENT_ID)).toBe("purchased");
  });

  it("releases the claim after a failed purchase so a retry succeeds", async () => {
    const store = makeClaimStore();
    claimShipmentForPurchaseMock.mockImplementation(store.claim);
    releaseShipmentClaimMock.mockImplementation(store.release);

    // First attempt: Shippo purchase throws.
    buyLabelMock.mockRejectedValueOnce(new Error("Shippo timeout"));

    const res1 = createResponse();
    await handler(makeRequest(validBody()), res1 as any);

    expect(res1.statusCode).toBe(500);
    expect(res1.jsonBody).toEqual({ error: "Shippo timeout" });

    // The claim must have been released so the shipment is retryable.
    expect(releaseShipmentClaimMock).toHaveBeenCalledWith(SHIPMENT_ID);
    expect(store.rows.get(SHIPMENT_ID)).toBe("owned");

    // Retry with the same request now succeeds and charges the seller once.
    const res2 = createResponse();
    await handler(makeRequest(validBody()), res2 as any);

    expect(res2.statusCode).toBe(200);
    expect(res2.jsonBody).toMatchObject({ success: true, id: 42 });
    expect(buyLabelMock).toHaveBeenCalledTimes(2);
    expect(store.rows.get(SHIPMENT_ID)).toBe("purchased");
  });
});

describe("/api/shipping/buy-label authorization & entitlement", () => {
  it("rejects a non-listed seller with 403 and never claims or charges", async () => {
    const store = makeClaimStore();
    claimShipmentForPurchaseMock.mockImplementation(store.claim);
    releaseShipmentClaimMock.mockImplementation(store.release);

    // Caller is signed in with a valid proof but has never listed a product.
    isListedSellerMock.mockResolvedValue(false);

    const res = createResponse();
    await handler(makeRequest(validBody()), res as any);

    expect(res.statusCode).toBe(403);
    expect(res.jsonBody).toEqual({
      error: "Only registered sellers may purchase shipping labels",
    });

    // Bailed before touching the shipment registry or Shippo.
    expect(getShipmentOwnerMock).not.toHaveBeenCalled();
    expect(claimShipmentForPurchaseMock).not.toHaveBeenCalled();
    expect(buyLabelMock).not.toHaveBeenCalled();
  });

  it("rejects an unregistered/expired shipment with 403 and never claims or charges", async () => {
    const store = makeClaimStore();
    claimShipmentForPurchaseMock.mockImplementation(store.claim);
    releaseShipmentClaimMock.mockImplementation(store.release);

    // No 'owned' row exists for this shipment (never quoted, or it expired).
    getShipmentOwnerMock.mockResolvedValue(null);

    const res = createResponse();
    await handler(makeRequest(validBody()), res as any);

    expect(res.statusCode).toBe(403);
    expect(res.jsonBody).toEqual({
      error:
        "Shipment not registered for purchase. Re-quote rates while signed in.",
    });

    // Bailed before claiming or charging.
    expect(claimShipmentForPurchaseMock).not.toHaveBeenCalled();
    expect(buyLabelMock).not.toHaveBeenCalled();
  });

  it("rejects a shipment owned by a different pubkey with 403 and never claims or charges", async () => {
    const store = makeClaimStore();
    claimShipmentForPurchaseMock.mockImplementation(store.claim);
    releaseShipmentClaimMock.mockImplementation(store.release);

    // The shipment was quoted by a different seller.
    getShipmentOwnerMock.mockResolvedValue("some-other-seller-pubkey");

    const res = createResponse();
    await handler(makeRequest(validBody()), res as any);

    expect(res.statusCode).toBe(403);
    expect(res.jsonBody).toEqual({
      error: "Shipment is owned by a different pubkey",
    });

    // Bailed before claiming or charging.
    expect(claimShipmentForPurchaseMock).not.toHaveBeenCalled();
    expect(buyLabelMock).not.toHaveBeenCalled();
  });

  it("releases the claim and returns 409 when the seller has no connected Shippo token", async () => {
    const store = makeClaimStore();
    claimShipmentForPurchaseMock.mockImplementation(store.claim);
    releaseShipmentClaimMock.mockImplementation(store.release);

    // The rightful seller owns the shipment but has not connected Shippo.
    getShippoAccessTokenMock.mockResolvedValue(null);

    const res = createResponse();
    await handler(makeRequest(validBody()), res as any);

    expect(res.statusCode).toBe(409);
    expect(res.jsonBody).toEqual({
      error:
        "Connect your Shippo account in Settings → Shipping before buying labels.",
    });

    // The claim was taken, then released so the shipment stays retryable.
    expect(claimShipmentForPurchaseMock).toHaveBeenCalledWith(
      SHIPMENT_ID,
      SELLER_PUBKEY
    );
    expect(releaseShipmentClaimMock).toHaveBeenCalledWith(SHIPMENT_ID);
    expect(store.rows.get(SHIPMENT_ID)).toBe("owned");

    // No charge happened.
    expect(buyLabelMock).not.toHaveBeenCalled();
  });
});

describe("/api/shipping/buy-label Herd (Pro) entitlement gate", () => {
  // The Pro gate runs AFTER the signed-event + listed-seller checks but BEFORE
  // any shipment ownership lookup, claim, or Shippo charge — so a seller without
  // an active Herd membership can never buy (and be charged for) a label.
  it("rejects a non-entitled (free/lapsed) seller with 403 and never claims or charges", async () => {
    const store = makeClaimStore();
    claimShipmentForPurchaseMock.mockImplementation(store.claim);
    releaseShipmentClaimMock.mockImplementation(store.release);

    isPubkeyProEntitledMock.mockResolvedValue(false);

    const res = createResponse();
    await handler(makeRequest(validBody()), res as any);

    expect(res.statusCode).toBe(403);
    expect(res.jsonBody).toEqual({
      error: "This feature requires an active Herd membership.",
    });

    // Bailed before touching the shipment registry or Shippo.
    expect(getShipmentOwnerMock).not.toHaveBeenCalled();
    expect(claimShipmentForPurchaseMock).not.toHaveBeenCalled();
    expect(buyLabelMock).not.toHaveBeenCalled();
  });

  it("returns 503 (and never charges) when membership cannot be resolved", async () => {
    const store = makeClaimStore();
    claimShipmentForPurchaseMock.mockImplementation(store.claim);
    releaseShipmentClaimMock.mockImplementation(store.release);

    isPubkeyProEntitledMock.mockRejectedValue(new Error("db down"));

    const res = createResponse();
    await handler(makeRequest(validBody()), res as any);

    expect(res.statusCode).toBe(503);
    expect(res.jsonBody).toEqual({
      error: "Could not verify membership. Please try again.",
    });
    expect(getShipmentOwnerMock).not.toHaveBeenCalled();
    expect(claimShipmentForPurchaseMock).not.toHaveBeenCalled();
    expect(buyLabelMock).not.toHaveBeenCalled();
  });
});

describe("/api/shipping/buy-label signed-event (cryptographic proof) guards", () => {
  // These 401 guards run BEFORE any seller / ownership / claim / charge logic,
  // so a forged, missing, expired, or mismatched signature must be rejected
  // without ever touching the registry or Shippo. Each test wires up a working
  // claim store purely to prove it is never consulted.
  function expectNoAuthOrCharge() {
    expect(isListedSellerMock).not.toHaveBeenCalled();
    expect(getShipmentOwnerMock).not.toHaveBeenCalled();
    expect(claimShipmentForPurchaseMock).not.toHaveBeenCalled();
    expect(buyLabelMock).not.toHaveBeenCalled();
  }

  it("rejects a request with no signed-event header with 401", async () => {
    const store = makeClaimStore();
    claimShipmentForPurchaseMock.mockImplementation(store.claim);
    releaseShipmentClaimMock.mockImplementation(store.release);

    // Build a request that omits the signed-event header entirely.
    const req = { method: "POST", headers: {}, body: validBody() } as any;
    const res = createResponse();
    await handler(req, res as any);

    expect(res.statusCode).toBe(401);
    expect(res.jsonBody).toEqual({
      error: "Missing signed event for label purchase",
    });

    // No proof was even parsed; nothing downstream ran.
    expect(parseSignedEventHeaderMock).not.toHaveBeenCalled();
    expectNoAuthOrCharge();
  });

  it("rejects an event that fails verifyEvent with 401", async () => {
    const store = makeClaimStore();
    claimShipmentForPurchaseMock.mockImplementation(store.claim);
    releaseShipmentClaimMock.mockImplementation(store.release);

    // Signature verification fails (forged / tampered event).
    verifyEventMock.mockReturnValue(false);

    const res = createResponse();
    await handler(makeRequest(validBody()), res as any);

    expect(res.statusCode).toBe(401);
    expect(res.jsonBody).toEqual({ error: "Invalid signed event" });

    // Bailed before freshness / match / auth / charge.
    expect(isMcpRequestProofFreshMock).not.toHaveBeenCalled();
    expect(matchesMcpRequestProofMock).not.toHaveBeenCalled();
    expectNoAuthOrCharge();
  });

  it("rejects an event with the wrong kind with 401", async () => {
    const store = makeClaimStore();
    claimShipmentForPurchaseMock.mockImplementation(store.claim);
    releaseShipmentClaimMock.mockImplementation(store.release);

    // A validly-signed event, but not the MCP request-proof kind.
    parseSignedEventHeaderMock.mockReturnValue({
      kind: MCP_REQUEST_PROOF_KIND + 1,
      pubkey: SELLER_PUBKEY,
      tags: [["path", "/api/shipping/buy-label"]],
    });

    const res = createResponse();
    await handler(makeRequest(validBody()), res as any);

    expect(res.statusCode).toBe(401);
    expect(res.jsonBody).toEqual({ error: "Invalid signed event" });

    expect(isMcpRequestProofFreshMock).not.toHaveBeenCalled();
    expect(matchesMcpRequestProofMock).not.toHaveBeenCalled();
    expectNoAuthOrCharge();
  });

  it("rejects an unparseable signed-event header with 401", async () => {
    const store = makeClaimStore();
    claimShipmentForPurchaseMock.mockImplementation(store.claim);
    releaseShipmentClaimMock.mockImplementation(store.release);

    // Header present but malformed → parseSignedEventHeader returns null.
    parseSignedEventHeaderMock.mockReturnValue(null);

    const res = createResponse();
    await handler(makeRequest(validBody()), res as any);

    expect(res.statusCode).toBe(401);
    expect(res.jsonBody).toEqual({ error: "Invalid signed event" });

    // verifyEvent is short-circuited by the null check.
    expect(verifyEventMock).not.toHaveBeenCalled();
    expect(isMcpRequestProofFreshMock).not.toHaveBeenCalled();
    expectNoAuthOrCharge();
  });

  it("rejects a stale (expired) event with 401", async () => {
    const store = makeClaimStore();
    claimShipmentForPurchaseMock.mockImplementation(store.claim);
    releaseShipmentClaimMock.mockImplementation(store.release);

    // Signature is valid and the right kind, but the proof is too old.
    isMcpRequestProofFreshMock.mockReturnValue(false);

    const res = createResponse();
    await handler(makeRequest(validBody()), res as any);

    expect(res.statusCode).toBe(401);
    expect(res.jsonBody).toEqual({ error: "Signed event expired" });

    // Bailed before matching the proof to the request, and before auth / charge.
    expect(matchesMcpRequestProofMock).not.toHaveBeenCalled();
    expectNoAuthOrCharge();
  });

  it("rejects a proof that does not match the request with 401", async () => {
    const store = makeClaimStore();
    claimShipmentForPurchaseMock.mockImplementation(store.claim);
    releaseShipmentClaimMock.mockImplementation(store.release);

    // Valid, fresh, correctly-signed event, but the proof was minted for a
    // different shipment/rate than the one in the request body.
    matchesMcpRequestProofMock.mockReturnValue(false);

    const res = createResponse();
    await handler(makeRequest(validBody()), res as any);

    expect(res.statusCode).toBe(401);
    expect(res.jsonBody).toEqual({
      error: "Signed event does not match request",
    });

    // Bailed before auth / claim / charge.
    expectNoAuthOrCharge();
  });
});
