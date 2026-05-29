/**
 * @jest-environment node
 *
 * Signed-event (cryptographic proof) rejection coverage for the Shippo OAuth
 * status endpoint (GET /api/shipping/oauth/status).
 *
 * This endpoint reveals whether a seller has a connected Shippo account (and
 * the account id / scope), so it must never run for an unauthenticated caller.
 * It delegates verification to verifyAndConsumeSignedRequestProof. These tests
 * prove the endpoint binds the proof to THIS operation + the query pubkey,
 * passes the header-extracted event to the verifier, and short-circuits with
 * the verifier's 401 on a missing / forged / expired / mismatched proof,
 * never reading the connection.
 */

const MCP_SIGNED_EVENT_HEADER = "x-mcp-signed-event";

const applyRateLimitMock = jest.fn();
const isShippoOAuthConfiguredMock = jest.fn();
const getShippoConnectionMock = jest.fn();
const verifyAndConsumeSignedRequestProofMock = jest.fn();
const parseSignedEventHeaderMock = jest.fn();
const buildShippingOAuthStatusProofMock = jest.fn();

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: (...args: unknown[]) => applyRateLimitMock(...args),
}));

jest.mock("@/utils/shipping/shippo-oauth", () => ({
  isShippoOAuthConfigured: (...args: unknown[]) =>
    isShippoOAuthConfiguredMock(...args),
}));

jest.mock("@/utils/db/shipping-service", () => ({
  getShippoConnection: (...args: unknown[]) => getShippoConnectionMock(...args),
}));

jest.mock("@/utils/mcp/request-proof-server", () => ({
  verifyAndConsumeSignedRequestProof: (...args: unknown[]) =>
    verifyAndConsumeSignedRequestProofMock(...args),
}));

jest.mock("@/utils/mcp/request-proof", () => ({
  MCP_SIGNED_EVENT_HEADER: "x-mcp-signed-event",
  parseSignedEventHeader: (...args: unknown[]) =>
    parseSignedEventHeaderMock(...args),
  buildShippingOAuthStatusProof: (...args: unknown[]) =>
    buildShippingOAuthStatusProofMock(...args),
}));

import handler from "@/pages/api/shipping/oauth/status";

const SELLER_PUBKEY = "seller-pubkey-abc";
const PARSED_EVENT = { id: "evt-1", pubkey: SELLER_PUBKEY, kind: 27235 };
const BUILT_PROOF = { action: "shipping_oauth_status", pubkey: SELLER_PUBKEY };

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

function makeRequest(
  query: Record<string, unknown> = { pubkey: SELLER_PUBKEY },
  withHeader = true
) {
  return {
    method: "GET",
    headers: withHeader
      ? { [MCP_SIGNED_EVENT_HEADER]: "signed-event-header" }
      : {},
    query,
  } as any;
}

beforeEach(() => {
  jest.clearAllMocks();

  applyRateLimitMock.mockReturnValue(true);
  isShippoOAuthConfiguredMock.mockReturnValue(true);
  getShippoConnectionMock.mockResolvedValue({
    accountId: "acct_1",
    scope: "label",
    createdAt: "2026-01-01",
  });
  parseSignedEventHeaderMock.mockReturnValue(PARSED_EVENT);
  buildShippingOAuthStatusProofMock.mockReturnValue(BUILT_PROOF);
  verifyAndConsumeSignedRequestProofMock.mockResolvedValue({
    ok: true,
    status: 200,
  });
});

describe("/api/shipping/oauth/status signed-event (cryptographic proof) guards", () => {
  it("accepts a valid proof and reads the connection status", async () => {
    const res = createResponse();
    await handler(makeRequest(), res as any);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toMatchObject({ configured: true, connected: true });
    expect(buildShippingOAuthStatusProofMock).toHaveBeenCalledWith(
      SELLER_PUBKEY
    );
    expect(verifyAndConsumeSignedRequestProofMock).toHaveBeenCalledWith(
      PARSED_EVENT,
      BUILT_PROOF
    );
    expect(getShippoConnectionMock).toHaveBeenCalledWith(SELLER_PUBKEY);
  });

  it("rejects a missing pubkey with 400 before any verification", async () => {
    const res = createResponse();
    await handler(makeRequest({}), res as any);

    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({ error: "pubkey is required" });
    expect(verifyAndConsumeSignedRequestProofMock).not.toHaveBeenCalled();
    expect(getShippoConnectionMock).not.toHaveBeenCalled();
  });

  it("rejects a request with no signed event with 401 and reads nothing", async () => {
    verifyAndConsumeSignedRequestProofMock.mockResolvedValue({
      ok: false,
      status: 401,
      error:
        "A signed Nostr request proof is required to prove pubkey ownership.",
    });

    const res = createResponse();
    await handler(makeRequest({ pubkey: SELLER_PUBKEY }, false), res as any);

    expect(res.statusCode).toBe(401);
    expect(res.jsonBody).toEqual({
      error:
        "A signed Nostr request proof is required to prove pubkey ownership.",
    });
    expect(verifyAndConsumeSignedRequestProofMock).toHaveBeenCalledWith(
      undefined,
      BUILT_PROOF
    );
    expect(getShippoConnectionMock).not.toHaveBeenCalled();
  });

  it("rejects a forged/invalid proof with 401 and reads nothing", async () => {
    verifyAndConsumeSignedRequestProofMock.mockResolvedValue({
      ok: false,
      status: 401,
      error: "Invalid signed request proof or pubkey mismatch.",
    });

    const res = createResponse();
    await handler(makeRequest(), res as any);

    expect(res.statusCode).toBe(401);
    expect(res.jsonBody).toEqual({
      error: "Invalid signed request proof or pubkey mismatch.",
    });
    expect(getShippoConnectionMock).not.toHaveBeenCalled();
  });

  it("rejects an expired proof with 401 and reads nothing", async () => {
    verifyAndConsumeSignedRequestProofMock.mockResolvedValue({
      ok: false,
      status: 401,
      error: "Signed request proof has expired. Please sign the request again.",
    });

    const res = createResponse();
    await handler(makeRequest(), res as any);

    expect(res.statusCode).toBe(401);
    expect(res.jsonBody).toEqual({
      error: "Signed request proof has expired. Please sign the request again.",
    });
    expect(getShippoConnectionMock).not.toHaveBeenCalled();
  });

  it("rejects a proof minted for a different operation with 401 and reads nothing", async () => {
    verifyAndConsumeSignedRequestProofMock.mockResolvedValue({
      ok: false,
      status: 401,
      error: "Signed request proof does not match this operation.",
    });

    const res = createResponse();
    await handler(makeRequest(), res as any);

    expect(res.statusCode).toBe(401);
    expect(res.jsonBody).toEqual({
      error: "Signed request proof does not match this operation.",
    });
    expect(buildShippingOAuthStatusProofMock).toHaveBeenCalledWith(
      SELLER_PUBKEY
    );
    expect(getShippoConnectionMock).not.toHaveBeenCalled();
  });
});
