/**
 * @jest-environment node
 *
 * Signed-event (cryptographic proof) rejection coverage for the Shippo OAuth
 * start endpoint (POST /api/shipping/oauth/start).
 *
 * This endpoint mints a single-use OAuth state row that begins linking a
 * seller's Shippo account, so it must never run for an unauthenticated caller.
 * Unlike the inline-guard endpoints, it delegates verification to
 * verifyAndConsumeSignedRequestProof. These tests prove the endpoint:
 *   - binds the proof to THIS operation + the body pubkey (build...Proof),
 *   - passes the extracted signed event to the verifier, and
 *   - short-circuits with the verifier's 401 on a missing / forged / expired /
 *     mismatched proof, never writing an OAuth state row.
 */

const MCP_SIGNED_EVENT_HEADER = "x-mcp-signed-event";

const applyRateLimitMock = jest.fn();
const isShippoOAuthConfiguredMock = jest.fn();
const buildShippoAuthorizeUrlMock = jest.fn();
const createShippoOAuthStateMock = jest.fn();
const verifyAndConsumeSignedRequestProofMock = jest.fn();
const parseSignedEventHeaderMock = jest.fn();
const buildShippingOAuthStartProofMock = jest.fn();
const isPubkeyProEntitledMock = jest.fn();

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: (...args: unknown[]) => applyRateLimitMock(...args),
}));

jest.mock("@/utils/shipping/shippo-oauth", () => ({
  isShippoOAuthConfigured: (...args: unknown[]) =>
    isShippoOAuthConfiguredMock(...args),
  buildShippoAuthorizeUrl: (...args: unknown[]) =>
    buildShippoAuthorizeUrlMock(...args),
}));

jest.mock("@/utils/db/shipping-service", () => ({
  createShippoOAuthState: (...args: unknown[]) =>
    createShippoOAuthStateMock(...args),
}));

jest.mock("@/utils/mcp/request-proof-server", () => ({
  verifyAndConsumeSignedRequestProof: (...args: unknown[]) =>
    verifyAndConsumeSignedRequestProofMock(...args),
}));

jest.mock("@/utils/pro/membership", () => ({
  isPubkeyProEntitled: (...args: unknown[]) => isPubkeyProEntitledMock(...args),
}));

jest.mock("@/utils/mcp/request-proof", () => ({
  MCP_SIGNED_EVENT_HEADER: "x-mcp-signed-event",
  parseSignedEventHeader: (...args: unknown[]) =>
    parseSignedEventHeaderMock(...args),
  buildShippingOAuthStartProof: (...args: unknown[]) =>
    buildShippingOAuthStartProofMock(...args),
}));

import handler from "@/pages/api/shipping/oauth/start";

const SELLER_PUBKEY = "seller-pubkey-abc";
const PARSED_EVENT = { id: "evt-1", pubkey: SELLER_PUBKEY, kind: 27235 };
const BUILT_PROOF = { action: "shipping_oauth_start", pubkey: SELLER_PUBKEY };

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
  isShippoOAuthConfiguredMock.mockReturnValue(true);
  buildShippoAuthorizeUrlMock.mockReturnValue(
    "https://goshippo.com/oauth/authorize?state=x"
  );
  createShippoOAuthStateMock.mockResolvedValue(undefined);
  parseSignedEventHeaderMock.mockReturnValue(PARSED_EVENT);
  buildShippingOAuthStartProofMock.mockReturnValue(BUILT_PROOF);
  verifyAndConsumeSignedRequestProofMock.mockResolvedValue({
    ok: true,
    status: 200,
  });
  isPubkeyProEntitledMock.mockResolvedValue(true);
});

describe("/api/shipping/oauth/start signed-event (cryptographic proof) guards", () => {
  it("accepts a valid proof and creates a single-use OAuth state", async () => {
    const res = createResponse();
    await handler(makeRequest(), res as any);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toMatchObject({ success: true });
    // The proof was bound to this operation + the body pubkey, and the parsed
    // event was handed to the verifier.
    expect(buildShippingOAuthStartProofMock).toHaveBeenCalledWith(
      SELLER_PUBKEY
    );
    expect(verifyAndConsumeSignedRequestProofMock).toHaveBeenCalledWith(
      PARSED_EVENT,
      BUILT_PROOF
    );
    expect(createShippoOAuthStateMock).toHaveBeenCalledTimes(1);
    expect(createShippoOAuthStateMock.mock.calls[0][0]).toBe(SELLER_PUBKEY);
  });

  it("rejects a missing pubkey with 400 before any verification", async () => {
    const res = createResponse();
    await handler(makeRequest({}), res as any);

    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({ error: "pubkey is required" });
    expect(verifyAndConsumeSignedRequestProofMock).not.toHaveBeenCalled();
    expect(createShippoOAuthStateMock).not.toHaveBeenCalled();
  });

  it("rejects a request with no signed event with 401 and writes no state", async () => {
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
    // No header and no body.signedEvent => the verifier was handed undefined.
    expect(verifyAndConsumeSignedRequestProofMock).toHaveBeenCalledWith(
      undefined,
      BUILT_PROOF
    );
    expect(createShippoOAuthStateMock).not.toHaveBeenCalled();
  });

  it("rejects a forged/invalid proof with 401 and writes no state", async () => {
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
    expect(createShippoOAuthStateMock).not.toHaveBeenCalled();
  });

  it("rejects an expired proof with 401 and writes no state", async () => {
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
    expect(createShippoOAuthStateMock).not.toHaveBeenCalled();
  });

  it("rejects a proof minted for a different operation with 401 and writes no state", async () => {
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
    // The endpoint still bound the proof to this operation + pubkey before
    // delegating, which is what makes a cross-operation replay fail.
    expect(buildShippingOAuthStartProofMock).toHaveBeenCalledWith(
      SELLER_PUBKEY
    );
    expect(createShippoOAuthStateMock).not.toHaveBeenCalled();
  });
});

describe("/api/shipping/oauth/start Herd (Pro) entitlement gate", () => {
  // Connecting a Shippo account is the entry point to the Herd shipping-labels
  // feature, so a verified-but-non-entitled seller must be blocked before any
  // OAuth state row is written.
  it("rejects a non-entitled seller with 403 and writes no state", async () => {
    isPubkeyProEntitledMock.mockResolvedValue(false);

    const res = createResponse();
    await handler(makeRequest(), res as any);

    expect(res.statusCode).toBe(403);
    expect(res.jsonBody).toEqual({
      error: "This feature requires an active Herd membership.",
    });
    expect(createShippoOAuthStateMock).not.toHaveBeenCalled();
    expect(buildShippoAuthorizeUrlMock).not.toHaveBeenCalled();
  });

  it("returns 503 (and writes no state) when membership cannot be resolved", async () => {
    isPubkeyProEntitledMock.mockRejectedValue(new Error("db down"));

    const res = createResponse();
    await handler(makeRequest(), res as any);

    expect(res.statusCode).toBe(503);
    expect(res.jsonBody).toEqual({
      error: "Could not verify membership. Please try again.",
    });
    expect(createShippoOAuthStateMock).not.toHaveBeenCalled();
  });
});
