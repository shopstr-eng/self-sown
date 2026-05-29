/**
 * @jest-environment node
 *
 * Regression coverage for duplicate return-label protection.
 *
 * Return labels create a brand-new Shippo shipment on every call, so there is
 * no client-supplied shipmentId to dedupe on. The handler instead derives a
 * deterministic idempotency key from the seller + the fields that define the
 * return, then claims it via an atomic DB guard so a double-click / retry can
 * never buy (and charge the seller for) the same return twice.
 *
 * These tests pin three behaviours that directly protect seller money:
 *   1. Two identical requests => exactly one purchase, deterministic 409 on the
 *      second.
 *   2. A failed purchase releases the claim so the seller can retry.
 *   3. The idempotency key is canonical: requests that differ only by object-key
 *      order, string casing/whitespace, or carrier array ordering hash to the
 *      same key.
 */

const MCP_SIGNED_EVENT_HEADER = "x-mcp-signed-event";
const MCP_REQUEST_PROOF_KIND = 27235;

const applyRateLimitMock = jest.fn();
const buyReturnLabelMock = jest.fn();
const isShippoOAuthConfiguredMock = jest.fn();
const isListedSellerMock = jest.fn();
const isMcpRequestProofFreshMock = jest.fn();
const parseSignedEventHeaderMock = jest.fn();
const verifyEventMock = jest.fn();

const claimShipmentForPurchaseMock = jest.fn();
const releaseShipmentClaimMock = jest.fn();
const getShippoAccessTokenMock = jest.fn();
const getShippingDefaultsForPubkeyMock = jest.fn();
const insertShippingLabelMock = jest.fn();

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: (...args: unknown[]) => applyRateLimitMock(...args),
}));

jest.mock("@/utils/shipping/shippo", () => ({
  buyReturnLabel: (...args: unknown[]) => buyReturnLabelMock(...args),
}));

jest.mock("@/utils/shipping/shippo-oauth", () => ({
  isShippoOAuthConfigured: (...args: unknown[]) =>
    isShippoOAuthConfiguredMock(...args),
}));

jest.mock("@/utils/shipping/shipment-owners", () => ({
  isListedSeller: (...args: unknown[]) => isListedSellerMock(...args),
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
}));

jest.mock("@/utils/db/shipping-service", () => ({
  claimShipmentForPurchase: (...args: unknown[]) =>
    claimShipmentForPurchaseMock(...args),
  releaseShipmentClaim: (...args: unknown[]) =>
    releaseShipmentClaimMock(...args),
  getShippoAccessToken: (...args: unknown[]) =>
    getShippoAccessTokenMock(...args),
  getShippingDefaultsForPubkey: (...args: unknown[]) =>
    getShippingDefaultsForPubkeyMock(...args),
  insertShippingLabel: (...args: unknown[]) => insertShippingLabelMock(...args),
}));

import handler from "@/pages/api/shipping/return-label";

const SELLER_PUBKEY = "seller-pubkey-abc";

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

// A complete, valid return-label body.
function validBody(overrides: Record<string, unknown> = {}) {
  return {
    orderId: "order-123",
    from: {
      name: "Buyer Person",
      street1: "100 Buyer St",
      city: "Buyerville",
      state: "CA",
      zip: "90001",
      country: "US",
    },
    parcel: { weightOz: 16, lengthIn: 6, widthIn: 4, heightIn: 2 },
    carriers: ["USPS", "UPS"],
    ...overrides,
  };
}

// Simulates the atomic DB claim guard for return labels. claimShipmentForPurchase
// inserts a row directly as 'purchased' (return labels have no prior 'owned'
// row); a second claim for the same key fails until releaseShipmentClaim reverts
// the row to 'owned'.
function makeClaimStore() {
  const rows = new Map<string, "owned" | "purchased">();
  return {
    rows,
    claim: jest.fn(async (key: string) => {
      const status = rows.get(key);
      if (status === "purchased") return false;
      rows.set(key, "purchased");
      return true;
    }),
    release: jest.fn(async (key: string) => {
      if (rows.get(key) === "purchased") rows.set(key, "owned");
    }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();

  applyRateLimitMock.mockReturnValue(true);
  isShippoOAuthConfiguredMock.mockReturnValue(true);
  verifyEventMock.mockReturnValue(true);
  isMcpRequestProofFreshMock.mockReturnValue(true);
  parseSignedEventHeaderMock.mockReturnValue({
    kind: MCP_REQUEST_PROOF_KIND,
    pubkey: SELLER_PUBKEY,
    tags: [["path", "/api/shipping/return-label"]],
  });

  isListedSellerMock.mockResolvedValue(true);
  getShippingDefaultsForPubkeyMock.mockResolvedValue({
    fromName: "Seller Shop",
    fromCompany: null,
    fromStreet1: "200 Seller Ave",
    fromStreet2: null,
    fromCity: "Sellertown",
    fromState: "NY",
    fromZip: "10001",
    fromCountry: "US",
    fromPhone: null,
    fromEmail: null,
  });
  getShippoAccessTokenMock.mockResolvedValue("oauth.seller-token");
  insertShippingLabelMock.mockResolvedValue({ id: 42 });
  buyReturnLabelMock.mockResolvedValue({
    shipmentId: "shp_123",
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

describe("/api/shipping/return-label duplicate protection", () => {
  it("buys exactly one label and returns a deterministic 409 on the duplicate", async () => {
    const store = makeClaimStore();
    claimShipmentForPurchaseMock.mockImplementation(store.claim);
    releaseShipmentClaimMock.mockImplementation(store.release);

    // First identical request: succeeds.
    const res1 = createResponse();
    await handler(makeRequest(validBody()), res1 as any);

    expect(res1.statusCode).toBe(200);
    expect(res1.jsonBody).toMatchObject({ success: true, id: 42 });
    expect(buyReturnLabelMock).toHaveBeenCalledTimes(1);

    // Second identical request: blocked by the claim, no second purchase.
    const res2 = createResponse();
    await handler(makeRequest(validBody()), res2 as any);

    expect(res2.statusCode).toBe(409);
    expect(res2.jsonBody).toEqual({
      error:
        "A return label for this order was already issued. Refresh to see it.",
    });

    // The seller is charged exactly once.
    expect(buyReturnLabelMock).toHaveBeenCalledTimes(1);

    // Both requests resolved to the same idempotency key.
    const key1 = claimShipmentForPurchaseMock.mock.calls[0][0];
    const key2 = claimShipmentForPurchaseMock.mock.calls[1][0];
    expect(key2).toBe(key1);
    expect(store.rows.get(key1)).toBe("purchased");
  });

  it("releases the claim after a failed purchase so a retry succeeds", async () => {
    const store = makeClaimStore();
    claimShipmentForPurchaseMock.mockImplementation(store.claim);
    releaseShipmentClaimMock.mockImplementation(store.release);

    // First attempt: Shippo purchase throws.
    buyReturnLabelMock.mockRejectedValueOnce(new Error("Shippo timeout"));

    const res1 = createResponse();
    await handler(makeRequest(validBody()), res1 as any);

    expect(res1.statusCode).toBe(500);
    expect(res1.jsonBody).toEqual({ error: "Shippo timeout" });

    // The claim must have been released so the key is retryable.
    const key = claimShipmentForPurchaseMock.mock.calls[0][0];
    expect(releaseShipmentClaimMock).toHaveBeenCalledWith(key);
    expect(store.rows.get(key)).toBe("owned");

    // Retry with the same request now succeeds and charges the seller once.
    const res2 = createResponse();
    await handler(makeRequest(validBody()), res2 as any);

    expect(res2.statusCode).toBe(200);
    expect(res2.jsonBody).toMatchObject({ success: true, id: 42 });
    expect(buyReturnLabelMock).toHaveBeenCalledTimes(2);
    expect(store.rows.get(key)).toBe("purchased");
  });
});

describe("/api/shipping/return-label canonical idempotency key", () => {
  // Capture the idempotency key for a single request without consuming a claim,
  // so each call is independent.
  async function keyFor(body: Record<string, unknown>): Promise<string> {
    claimShipmentForPurchaseMock.mockReset();
    claimShipmentForPurchaseMock.mockResolvedValue(true);
    const res = createResponse();
    await handler(makeRequest(body), res as any);
    expect(res.statusCode).toBe(200);
    return claimShipmentForPurchaseMock.mock.calls[0][0] as string;
  }

  it("hashes identically when object-key order differs", async () => {
    const a = await keyFor({
      orderId: "order-1",
      from: { street1: "1 A St", city: "Town", state: "CA", zip: "90001" },
      parcel: { weightOz: 10 },
    });
    const b = await keyFor({
      parcel: { weightOz: 10 },
      from: { zip: "90001", state: "CA", city: "Town", street1: "1 A St" },
      orderId: "order-1",
    });
    expect(b).toBe(a);
  });

  it("hashes identically across string casing and whitespace differences", async () => {
    const a = await keyFor({
      orderId: "order-1",
      from: { street1: "1 A St", city: "Town", state: "CA", zip: "90001" },
      parcel: { weightOz: 10 },
    });
    const b = await keyFor({
      orderId: "  ORDER-1 ",
      from: {
        street1: " 1 a ST ",
        city: "TOWN",
        state: " ca ",
        zip: "90001",
      },
      parcel: { weightOz: 10 },
    });
    expect(b).toBe(a);
  });

  it("hashes identically regardless of carrier array ordering", async () => {
    const a = await keyFor({
      orderId: "order-1",
      from: { street1: "1 A St", city: "Town", state: "CA", zip: "90001" },
      parcel: { weightOz: 10 },
      carriers: ["USPS", "UPS", "FedEx"],
    });
    const b = await keyFor({
      orderId: "order-1",
      from: { street1: "1 A St", city: "Town", state: "CA", zip: "90001" },
      parcel: { weightOz: 10 },
      carriers: ["FedEx", "USPS", "UPS"],
    });
    expect(b).toBe(a);
  });

  it("produces a different key for a materially different return", async () => {
    const a = await keyFor({
      orderId: "order-1",
      from: { street1: "1 A St", city: "Town", state: "CA", zip: "90001" },
      parcel: { weightOz: 10 },
    });
    const b = await keyFor({
      orderId: "order-2",
      from: { street1: "1 A St", city: "Town", state: "CA", zip: "90001" },
      parcel: { weightOz: 10 },
    });
    expect(b).not.toBe(a);
  });
});

describe("/api/shipping/return-label signed-event (cryptographic proof) guards", () => {
  // These 401 guards run BEFORE any seller / defaults / claim / charge logic,
  // so a forged, missing, expired, or mismatched signature must be rejected
  // without ever touching the registry or Shippo. Each test wires up a working
  // claim store purely to prove it is never consulted. Unlike buy-label, the
  // return-label handler binds the proof to the request via a "path" tag rather
  // than matchesMcpRequestProof, so the final guard is exercised by pointing
  // that tag at a different endpoint.
  function expectNoAuthOrCharge() {
    expect(isListedSellerMock).not.toHaveBeenCalled();
    expect(getShippingDefaultsForPubkeyMock).not.toHaveBeenCalled();
    expect(claimShipmentForPurchaseMock).not.toHaveBeenCalled();
    expect(buyReturnLabelMock).not.toHaveBeenCalled();
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
    expect(res.jsonBody).toEqual({ error: "Missing signed event" });

    // No proof was even parsed; nothing downstream ran.
    expect(parseSignedEventHeaderMock).not.toHaveBeenCalled();
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

    // Bailed before freshness / path-match / auth / charge.
    expect(isMcpRequestProofFreshMock).not.toHaveBeenCalled();
    expectNoAuthOrCharge();
  });

  it("rejects an event with the wrong kind with 401", async () => {
    const store = makeClaimStore();
    claimShipmentForPurchaseMock.mockImplementation(store.claim);
    releaseShipmentClaimMock.mockImplementation(store.release);

    // A validly-signed event, but not the MCP request-proof kind. The kind
    // check short-circuits before verifyEvent even runs.
    parseSignedEventHeaderMock.mockReturnValue({
      kind: MCP_REQUEST_PROOF_KIND + 1,
      pubkey: SELLER_PUBKEY,
      tags: [["path", "/api/shipping/return-label"]],
    });

    const res = createResponse();
    await handler(makeRequest(validBody()), res as any);

    expect(res.statusCode).toBe(401);
    expect(res.jsonBody).toEqual({ error: "Invalid signed event" });

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

    // Bailed before binding the proof to the request, and before auth / charge.
    expectNoAuthOrCharge();
  });

  it("rejects a proof bound to a different endpoint path with 401", async () => {
    const store = makeClaimStore();
    claimShipmentForPurchaseMock.mockImplementation(store.claim);
    releaseShipmentClaimMock.mockImplementation(store.release);

    // Valid, fresh, correctly-signed event, but the "path" tag was minted for a
    // different endpoint (e.g. the outbound buy-label route), so it must not be
    // replayable against return-label.
    parseSignedEventHeaderMock.mockReturnValue({
      kind: MCP_REQUEST_PROOF_KIND,
      pubkey: SELLER_PUBKEY,
      tags: [["path", "/api/shipping/buy-label"]],
    });

    const res = createResponse();
    await handler(makeRequest(validBody()), res as any);

    expect(res.statusCode).toBe(401);
    expect(res.jsonBody).toEqual({
      error: "Signed event does not match request",
    });

    // Bailed before auth / claim / charge.
    expectNoAuthOrCharge();
  });

  it("rejects a proof with no path tag at all with 401", async () => {
    const store = makeClaimStore();
    claimShipmentForPurchaseMock.mockImplementation(store.claim);
    releaseShipmentClaimMock.mockImplementation(store.release);

    // Valid, fresh, correctly-signed event, but missing the "path" tag entirely.
    parseSignedEventHeaderMock.mockReturnValue({
      kind: MCP_REQUEST_PROOF_KIND,
      pubkey: SELLER_PUBKEY,
      tags: [],
    });

    const res = createResponse();
    await handler(makeRequest(validBody()), res as any);

    expect(res.statusCode).toBe(401);
    expect(res.jsonBody).toEqual({
      error: "Signed event does not match request",
    });

    expectNoAuthOrCharge();
  });
});
