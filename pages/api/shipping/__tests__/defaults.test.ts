/**
 * @jest-environment node
 *
 * Signed-event (cryptographic proof) rejection coverage for the ship-from
 * defaults endpoint (GET/POST /api/shipping/defaults).
 *
 * This endpoint reads and rewrites a seller's default ship-from address. The
 * 401 guard must reject a missing, malformed, forged, wrong-kind, expired, or
 * mismatched signed event BEFORE any DB read or write. Every test proves the
 * guard short-circuits before getShippingDefaultsForPubkey /
 * upsertShippingDefaults are ever called, so an unauthorized caller can neither
 * read nor overwrite another seller's ship-from address.
 */

const MCP_SIGNED_EVENT_HEADER = "x-mcp-signed-event";
const MCP_REQUEST_PROOF_KIND = 27235;

const applyRateLimitMock = jest.fn();
const isMcpRequestProofFreshMock = jest.fn();
const parseSignedEventHeaderMock = jest.fn();
const verifyEventMock = jest.fn();
const getShippingDefaultsForPubkeyMock = jest.fn();
const upsertShippingDefaultsMock = jest.fn();

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: (...args: unknown[]) => applyRateLimitMock(...args),
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
  getShippingDefaultsForPubkey: (...args: unknown[]) =>
    getShippingDefaultsForPubkeyMock(...args),
  upsertShippingDefaults: (...args: unknown[]) =>
    upsertShippingDefaultsMock(...args),
}));

import handler from "@/pages/api/shipping/defaults";

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

// Defaults guards are exercised against POST (the write path) unless a test
// overrides the method. The proof's "method" tag must match req.method.
function makeRequest(method = "POST", body: Record<string, unknown> = {}) {
  return {
    method,
    headers: { [MCP_SIGNED_EVENT_HEADER]: "signed-event-header" },
    body,
  } as any;
}

beforeEach(() => {
  jest.clearAllMocks();

  applyRateLimitMock.mockReturnValue(true);
  verifyEventMock.mockReturnValue(true);
  isMcpRequestProofFreshMock.mockReturnValue(true);
  parseSignedEventHeaderMock.mockReturnValue({
    kind: MCP_REQUEST_PROOF_KIND,
    pubkey: SELLER_PUBKEY,
    tags: [
      ["path", "/api/shipping/defaults"],
      ["method", "POST"],
    ],
  });
  getShippingDefaultsForPubkeyMock.mockResolvedValue({ fromZip: "10001" });
  upsertShippingDefaultsMock.mockResolvedValue({ fromZip: "10001" });
});

describe("/api/shipping/defaults signed-event (cryptographic proof) guards", () => {
  // The 401 guard runs BEFORE any DB read/write, so a forged / missing /
  // expired / mismatched signature must never touch the defaults table.
  function expectNoDb() {
    expect(getShippingDefaultsForPubkeyMock).not.toHaveBeenCalled();
    expect(upsertShippingDefaultsMock).not.toHaveBeenCalled();
  }

  it("accepts a valid POST signed event and writes the defaults", async () => {
    const res = createResponse();
    await handler(makeRequest("POST", { fromZip: "10001" }), res as any);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toMatchObject({ success: true });
    expect(upsertShippingDefaultsMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a request with no signed-event header with 401", async () => {
    const req = { method: "POST", headers: {}, body: {} } as any;
    const res = createResponse();
    await handler(req, res as any);

    expect(res.statusCode).toBe(401);
    expect(res.jsonBody).toEqual({ error: "Missing signed event" });
    expect(parseSignedEventHeaderMock).not.toHaveBeenCalled();
    expectNoDb();
  });

  it("rejects an unparseable signed-event header with 401", async () => {
    parseSignedEventHeaderMock.mockReturnValue(null);

    const res = createResponse();
    await handler(makeRequest(), res as any);

    expect(res.statusCode).toBe(401);
    expect(res.jsonBody).toEqual({ error: "Invalid signed event" });
    expect(verifyEventMock).not.toHaveBeenCalled();
    expect(isMcpRequestProofFreshMock).not.toHaveBeenCalled();
    expectNoDb();
  });

  it("rejects an event that fails verifyEvent with 401", async () => {
    verifyEventMock.mockReturnValue(false);

    const res = createResponse();
    await handler(makeRequest(), res as any);

    expect(res.statusCode).toBe(401);
    expect(res.jsonBody).toEqual({ error: "Invalid signed event" });
    expect(isMcpRequestProofFreshMock).not.toHaveBeenCalled();
    expectNoDb();
  });

  it("rejects an event with the wrong kind with 401", async () => {
    parseSignedEventHeaderMock.mockReturnValue({
      kind: MCP_REQUEST_PROOF_KIND + 1,
      pubkey: SELLER_PUBKEY,
      tags: [
        ["path", "/api/shipping/defaults"],
        ["method", "POST"],
      ],
    });

    const res = createResponse();
    await handler(makeRequest(), res as any);

    expect(res.statusCode).toBe(401);
    expect(res.jsonBody).toEqual({ error: "Invalid signed event" });
    expect(verifyEventMock).not.toHaveBeenCalled();
    expect(isMcpRequestProofFreshMock).not.toHaveBeenCalled();
    expectNoDb();
  });

  it("rejects a stale (expired) event with 401", async () => {
    isMcpRequestProofFreshMock.mockReturnValue(false);

    const res = createResponse();
    await handler(makeRequest(), res as any);

    expect(res.statusCode).toBe(401);
    expect(res.jsonBody).toEqual({ error: "Signed event expired" });
    expectNoDb();
  });

  it("rejects a proof bound to a different endpoint path with 401", async () => {
    parseSignedEventHeaderMock.mockReturnValue({
      kind: MCP_REQUEST_PROOF_KIND,
      pubkey: SELLER_PUBKEY,
      tags: [
        ["path", "/api/shipping/parcel-templates"],
        ["method", "POST"],
      ],
    });

    const res = createResponse();
    await handler(makeRequest(), res as any);

    expect(res.statusCode).toBe(401);
    expect(res.jsonBody).toEqual({
      error: "Signed event does not match request",
    });
    expectNoDb();
  });

  it("rejects a proof minted for a different HTTP method with 401", async () => {
    // Proof was signed for a GET (read), but replayed against a POST (write).
    parseSignedEventHeaderMock.mockReturnValue({
      kind: MCP_REQUEST_PROOF_KIND,
      pubkey: SELLER_PUBKEY,
      tags: [
        ["path", "/api/shipping/defaults"],
        ["method", "GET"],
      ],
    });

    const res = createResponse();
    await handler(makeRequest("POST"), res as any);

    expect(res.statusCode).toBe(401);
    expect(res.jsonBody).toEqual({
      error: "Signed event does not match request",
    });
    expectNoDb();
  });
});
