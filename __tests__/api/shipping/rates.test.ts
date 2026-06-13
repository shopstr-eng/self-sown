/**
 * @jest-environment node
 *
 * Signed-event (cryptographic proof) rejection coverage for the rate-quoting
 * endpoint (POST /api/shipping/rates).
 *
 * Unlike the other shipping endpoints, /rates is intentionally *soft auth*: a
 * buyer estimating checkout shipping has no signature, so a bad / missing
 * signed event does NOT 401. Instead the rule is narrower but just as critical:
 * a forged, malformed, wrong-kind, or expired signed event must never be
 * treated as the authenticated seller, so it can neither (a) impersonate a
 * seller to quote against that seller's connected Shippo account, nor (b)
 * register shipment ownership (rememberShipmentOwner) that /buy-label later
 * trusts to authorize a charge.
 *
 * These tests pin that a bad signature is silently NOT honored: ownership is
 * never recorded, and the caller only ever quotes via an explicit sellerPubkey
 * (the buyer-checkout path), never via the unverified event pubkey.
 */

const MCP_SIGNED_EVENT_HEADER = "x-mcp-signed-event";
const MCP_REQUEST_PROOF_KIND = 27235;

const applyRateLimitMock = jest.fn();
const isShippoOAuthConfiguredMock = jest.fn();
const getRatesMock = jest.fn();
const getShippoAccessTokenMock = jest.fn();
const rememberShipmentOwnerMock = jest.fn();
const isListedSellerMock = jest.fn();
const isMcpRequestProofFreshMock = jest.fn();
const parseSignedEventHeaderMock = jest.fn();
const verifyEventMock = jest.fn();
const isPubkeyProEntitledMock = jest.fn();

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: (...args: unknown[]) => applyRateLimitMock(...args),
}));

jest.mock("@/utils/shipping/shippo", () => ({
  getRates: (...args: unknown[]) => getRatesMock(...args),
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
}));

jest.mock("@/utils/db/shipping-service", () => ({
  getShippoAccessToken: (...args: unknown[]) =>
    getShippoAccessTokenMock(...args),
  rememberShipmentOwner: (...args: unknown[]) =>
    rememberShipmentOwnerMock(...args),
}));

import handler from "@/pages/api/shipping/rates";

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

// A complete, valid rates body. By default it carries NO sellerPubkey, so the
// ONLY way a quote can succeed is if the signed event authenticates the seller.
// That makes "bad signature => No seller specified" a clean assertion.
function validBody(overrides: Record<string, unknown> = {}) {
  return {
    from: {
      zip: "10001",
      country: "US",
      street1: "200 Seller Ave",
      city: "Sellertown",
      state: "NY",
    },
    to: {
      street1: "100 Buyer St",
      city: "Buyerville",
      state: "CA",
      zip: "90001",
      country: "US",
    },
    parcel: { weightOz: 16 },
    ...overrides,
  };
}

function makeRequest(body: Record<string, unknown>, withHeader = true) {
  return {
    method: "POST",
    headers: withHeader
      ? { [MCP_SIGNED_EVENT_HEADER]: "signed-event-header" }
      : {},
    body,
  } as any;
}

beforeEach(() => {
  jest.clearAllMocks();

  applyRateLimitMock.mockReturnValue(true);
  isShippoOAuthConfiguredMock.mockReturnValue(true);
  verifyEventMock.mockReturnValue(true);
  isMcpRequestProofFreshMock.mockReturnValue(true);
  isListedSellerMock.mockResolvedValue(true);
  isPubkeyProEntitledMock.mockResolvedValue(true);
  parseSignedEventHeaderMock.mockReturnValue({
    kind: MCP_REQUEST_PROOF_KIND,
    pubkey: SELLER_PUBKEY,
    tags: [["path", "/api/shipping/rates"]],
  });
  getShippoAccessTokenMock.mockResolvedValue("oauth.seller-token");
  rememberShipmentOwnerMock.mockResolvedValue(undefined);
  getRatesMock.mockResolvedValue({
    shipmentId: "shp_rate_1",
    rates: [{ rateId: "r1", amount: 7.5 }],
    cheapest: { rateId: "r1", amount: 7.5 },
  });
});

describe("/api/shipping/rates seller authentication via signed event", () => {
  it("treats a valid signed event as the seller and records shipment ownership", async () => {
    const res = createResponse();
    await handler(makeRequest(validBody()), res as any);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toMatchObject({
      success: true,
      shipmentId: "shp_rate_1",
    });
    // The authenticated seller's connected account was used to quote, and the
    // shipment was registered to them so /buy-label can authorize the purchase.
    expect(getShippoAccessTokenMock).toHaveBeenCalledWith(SELLER_PUBKEY);
    expect(getRatesMock).toHaveBeenCalledTimes(1);
    expect(rememberShipmentOwnerMock).toHaveBeenCalledWith(
      "shp_rate_1",
      SELLER_PUBKEY
    );
  });
});

describe("/api/shipping/rates rejects bad signatures (never grants seller identity)", () => {
  // With no sellerPubkey in the body, an unhonored signature leaves the request
  // with no seller at all, so the handler returns the "No seller specified"
  // soft error and never quotes or records ownership.
  function expectNotHonored(res: ReturnType<typeof createResponse>) {
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toMatchObject({
      success: false,
      error: "No seller specified for shipping rates",
    });
    expect(getShippoAccessTokenMock).not.toHaveBeenCalled();
    expect(getRatesMock).not.toHaveBeenCalled();
    expect(rememberShipmentOwnerMock).not.toHaveBeenCalled();
  }

  it("does not honor a request with no signed-event header", async () => {
    const res = createResponse();
    await handler(makeRequest(validBody(), false), res as any);

    expect(parseSignedEventHeaderMock).not.toHaveBeenCalled();
    expect(isListedSellerMock).not.toHaveBeenCalled();
    expectNotHonored(res);
  });

  it("does not honor an unparseable signed-event header", async () => {
    parseSignedEventHeaderMock.mockReturnValue(null);

    const res = createResponse();
    await handler(makeRequest(validBody()), res as any);

    expect(verifyEventMock).not.toHaveBeenCalled();
    expect(isListedSellerMock).not.toHaveBeenCalled();
    expectNotHonored(res);
  });

  it("does not honor an event that fails verifyEvent (forged/tampered)", async () => {
    verifyEventMock.mockReturnValue(false);

    const res = createResponse();
    await handler(makeRequest(validBody()), res as any);

    expect(isMcpRequestProofFreshMock).not.toHaveBeenCalled();
    expect(isListedSellerMock).not.toHaveBeenCalled();
    expectNotHonored(res);
  });

  it("does not honor an event with the wrong kind", async () => {
    parseSignedEventHeaderMock.mockReturnValue({
      kind: MCP_REQUEST_PROOF_KIND + 1,
      pubkey: SELLER_PUBKEY,
      tags: [["path", "/api/shipping/rates"]],
    });

    const res = createResponse();
    await handler(makeRequest(validBody()), res as any);

    expect(verifyEventMock).not.toHaveBeenCalled();
    expect(isListedSellerMock).not.toHaveBeenCalled();
    expectNotHonored(res);
  });

  it("does not honor a stale (expired) event", async () => {
    isMcpRequestProofFreshMock.mockReturnValue(false);

    const res = createResponse();
    await handler(makeRequest(validBody()), res as any);

    expect(isListedSellerMock).not.toHaveBeenCalled();
    expectNotHonored(res);
  });

  it("does not honor a valid event whose pubkey is not a listed seller", async () => {
    isListedSellerMock.mockResolvedValue(false);

    const res = createResponse();
    await handler(makeRequest(validBody()), res as any);

    expect(isListedSellerMock).toHaveBeenCalledWith(SELLER_PUBKEY);
    expectNotHonored(res);
  });

  it("falls back to the buyer's sellerPubkey but never records ownership for a forged event", async () => {
    // A forged signature plus a buyer-supplied sellerPubkey: the buyer-checkout
    // path still quotes against that seller, but the forged event must NOT be
    // credited as the shipment owner.
    verifyEventMock.mockReturnValue(false);

    const res = createResponse();
    await handler(
      makeRequest(validBody({ sellerPubkey: "buyer-chosen-seller" })),
      res as any
    );

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toMatchObject({
      success: true,
      shipmentId: "shp_rate_1",
    });
    // Quoted against the explicitly-named seller, NOT the forged event pubkey.
    expect(getShippoAccessTokenMock).toHaveBeenCalledWith(
      "buyer-chosen-seller"
    );
    expect(getRatesMock).toHaveBeenCalledTimes(1);
    // Crucially, no ownership was recorded off the back of the forged event.
    expect(rememberShipmentOwnerMock).not.toHaveBeenCalled();
  });
});

describe("/api/shipping/rates Herd (Pro) entitlement gate", () => {
  // A *seller* quoting their own rates via a valid signed event must hold an
  // active Herd membership. Crucially, the *buyer* checkout path (explicit
  // sellerPubkey, no honored signature) must stay open regardless of the
  // seller's membership so guest checkout can always display live rates.
  it("rejects a signed-in non-entitled seller with 403 and never quotes or records ownership", async () => {
    isPubkeyProEntitledMock.mockResolvedValue(false);

    const res = createResponse();
    await handler(makeRequest(validBody()), res as any);

    expect(res.statusCode).toBe(403);
    expect(res.jsonBody).toEqual({
      error: "This feature requires an active Herd membership.",
    });
    expect(getShippoAccessTokenMock).not.toHaveBeenCalled();
    expect(getRatesMock).not.toHaveBeenCalled();
    expect(rememberShipmentOwnerMock).not.toHaveBeenCalled();
  });

  it("returns 503 (and never quotes) when the seller's membership cannot be resolved", async () => {
    isPubkeyProEntitledMock.mockRejectedValue(new Error("db down"));

    const res = createResponse();
    await handler(makeRequest(validBody()), res as any);

    expect(res.statusCode).toBe(503);
    expect(res.jsonBody).toEqual({
      error: "Could not verify membership. Please try again.",
    });
    expect(getRatesMock).not.toHaveBeenCalled();
    expect(rememberShipmentOwnerMock).not.toHaveBeenCalled();
  });

  it("still quotes the buyer-checkout path even when the seller is not Pro-entitled", async () => {
    // Buyer checkout: no honored signature (forged event), explicit sellerPubkey
    // in the body. The Pro gate only applies to the signed-seller branch, so a
    // non-entitled membership must NOT block guest live-rate quotes.
    isPubkeyProEntitledMock.mockResolvedValue(false);
    verifyEventMock.mockReturnValue(false);

    const res = createResponse();
    await handler(
      makeRequest(validBody({ sellerPubkey: "buyer-chosen-seller" })),
      res as any
    );

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toMatchObject({
      success: true,
      shipmentId: "shp_rate_1",
    });
    expect(getShippoAccessTokenMock).toHaveBeenCalledWith(
      "buyer-chosen-seller"
    );
    expect(getRatesMock).toHaveBeenCalledTimes(1);
    // The Pro gate was never consulted for the buyer path.
    expect(isPubkeyProEntitledMock).not.toHaveBeenCalled();
    expect(rememberShipmentOwnerMock).not.toHaveBeenCalled();
  });
});
