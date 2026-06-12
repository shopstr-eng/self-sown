/**
 * @jest-environment node
 *
 * Signed-event (cryptographic proof) rejection coverage for the Shippo OAuth
 * disconnect endpoint (POST /api/shipping/oauth/disconnect).
 *
 * This endpoint deletes a seller's Shippo connection, severing their ability to
 * buy labels, so it must never run for an unauthenticated caller. It delegates
 * verification to verifyAndConsumeSignedRequestProof. These tests prove the
 * endpoint binds the proof to THIS operation + the body pubkey, passes the
 * extracted signed event to the verifier, and short-circuits with the
 * verifier's 401 on a missing / forged / expired / mismatched proof, never
 * deleting the connection.
 */

const MCP_SIGNED_EVENT_HEADER = "x-mcp-signed-event";

const applyRateLimitMock = jest.fn();
const deleteShippoConnectionMock = jest.fn();
const verifyAndConsumeSignedRequestProofMock = jest.fn();
const parseSignedEventHeaderMock = jest.fn();
const buildShippingOAuthDisconnectProofMock = jest.fn();

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: (...args: unknown[]) => applyRateLimitMock(...args),
}));

jest.mock("@/utils/db/shipping-service", () => ({
  deleteShippoConnection: (...args: unknown[]) =>
    deleteShippoConnectionMock(...args),
}));

jest.mock("@/utils/mcp/request-proof-server", () => ({
  verifyAndConsumeSignedRequestProof: (...args: unknown[]) =>
    verifyAndConsumeSignedRequestProofMock(...args),
}));

jest.mock("@/utils/mcp/request-proof", () => ({
  MCP_SIGNED_EVENT_HEADER: "x-mcp-signed-event",
  parseSignedEventHeader: (...args: unknown[]) =>
    parseSignedEventHeaderMock(...args),
  buildShippingOAuthDisconnectProof: (...args: unknown[]) =>
    buildShippingOAuthDisconnectProofMock(...args),
}));

import handler from "@/pages/api/shipping/oauth/disconnect";

const SELLER_PUBKEY = "seller-pubkey-abc";
const PARSED_EVENT = { id: "evt-1", pubkey: SELLER_PUBKEY, kind: 27235 };
const BUILT_PROOF = {
  action: "shipping_oauth_disconnect",
  pubkey: SELLER_PUBKEY,
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

function makeRequest(
  body: Record<string, unknown> = { pubkey: SELLER_PUBKEY },
  withHeader = true
) {
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
  deleteShippoConnectionMock.mockResolvedValue(undefined);
  parseSignedEventHeaderMock.mockReturnValue(PARSED_EVENT);
  buildShippingOAuthDisconnectProofMock.mockReturnValue(BUILT_PROOF);
  verifyAndConsumeSignedRequestProofMock.mockResolvedValue({
    ok: true,
    status: 200,
  });
});

describe("/api/shipping/oauth/disconnect signed-event (cryptographic proof) guards", () => {
  it("accepts a valid proof and deletes the connection", async () => {
    const res = createResponse();
    await handler(makeRequest(), res as any);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({ success: true });
    expect(buildShippingOAuthDisconnectProofMock).toHaveBeenCalledWith(
      SELLER_PUBKEY
    );
    expect(verifyAndConsumeSignedRequestProofMock).toHaveBeenCalledWith(
      PARSED_EVENT,
      BUILT_PROOF
    );
    expect(deleteShippoConnectionMock).toHaveBeenCalledWith(SELLER_PUBKEY);
  });

  it("rejects a missing pubkey with 400 before any verification", async () => {
    const res = createResponse();
    await handler(makeRequest({}), res as any);

    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({ error: "pubkey is required" });
    expect(verifyAndConsumeSignedRequestProofMock).not.toHaveBeenCalled();
    expect(deleteShippoConnectionMock).not.toHaveBeenCalled();
  });

  it("rejects a request with no signed event with 401 and deletes nothing", async () => {
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
    expect(deleteShippoConnectionMock).not.toHaveBeenCalled();
  });

  it("rejects a forged/invalid proof with 401 and deletes nothing", async () => {
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
    expect(deleteShippoConnectionMock).not.toHaveBeenCalled();
  });

  it("rejects an expired proof with 401 and deletes nothing", async () => {
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
    expect(deleteShippoConnectionMock).not.toHaveBeenCalled();
  });

  it("rejects a proof minted for a different operation with 401 and deletes nothing", async () => {
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
    expect(buildShippingOAuthDisconnectProofMock).toHaveBeenCalledWith(
      SELLER_PUBKEY
    );
    expect(deleteShippoConnectionMock).not.toHaveBeenCalled();
  });
});
