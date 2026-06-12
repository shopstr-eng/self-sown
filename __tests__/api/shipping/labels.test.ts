/**
 * @jest-environment node
 *
 * Signed-event (cryptographic proof) rejection coverage for the shipping
 * label-history endpoint (GET /api/shipping/labels).
 *
 * This endpoint exposes a seller's full purchased-label history. The 401 guard
 * must reject a missing, malformed, forged, wrong-kind, expired, or mismatched
 * signed event BEFORE any database read. Every test proves the guard
 * short-circuits before listShippingLabelsForPubkey is ever consulted, so an
 * unauthorized caller can never read another seller's labels.
 */

const MCP_SIGNED_EVENT_HEADER = "x-mcp-signed-event";
const MCP_REQUEST_PROOF_KIND = 27235;

const applyRateLimitMock = jest.fn();
const isMcpRequestProofFreshMock = jest.fn();
const parseSignedEventHeaderMock = jest.fn();
const verifyEventMock = jest.fn();
const listShippingLabelsForPubkeyMock = jest.fn();

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
  listShippingLabelsForPubkey: (...args: unknown[]) =>
    listShippingLabelsForPubkeyMock(...args),
}));

import handler from "@/pages/api/shipping/labels";

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

function makeRequest() {
  return {
    method: "GET",
    headers: { [MCP_SIGNED_EVENT_HEADER]: "signed-event-header" },
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
      ["action", "shipping_list_labels"],
      ["path", "/api/shipping/labels"],
    ],
  });
  listShippingLabelsForPubkeyMock.mockResolvedValue([{ id: 1 }]);
});

describe("/api/shipping/labels signed-event (cryptographic proof) guards", () => {
  // The 401 guard runs BEFORE any DB read, so a forged / missing / expired /
  // mismatched signature must be rejected without ever reading label history.
  function expectNoRead() {
    expect(listShippingLabelsForPubkeyMock).not.toHaveBeenCalled();
  }

  it("accepts a valid signed event and returns the label history", async () => {
    const res = createResponse();
    await handler(makeRequest(), res as any);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({ success: true, labels: [{ id: 1 }] });
    expect(listShippingLabelsForPubkeyMock).toHaveBeenCalledWith(
      SELLER_PUBKEY,
      200
    );
  });

  it("rejects a request with no signed-event header with 401", async () => {
    const req = { method: "GET", headers: {} } as any;
    const res = createResponse();
    await handler(req, res as any);

    expect(res.statusCode).toBe(401);
    expect(res.jsonBody).toEqual({ error: "Missing signed event" });
    expect(parseSignedEventHeaderMock).not.toHaveBeenCalled();
    expectNoRead();
  });

  it("rejects an unparseable signed-event header with 401", async () => {
    parseSignedEventHeaderMock.mockReturnValue(null);

    const res = createResponse();
    await handler(makeRequest(), res as any);

    expect(res.statusCode).toBe(401);
    expect(res.jsonBody).toEqual({ error: "Invalid signed event" });
    expect(verifyEventMock).not.toHaveBeenCalled();
    expect(isMcpRequestProofFreshMock).not.toHaveBeenCalled();
    expectNoRead();
  });

  it("rejects an event that fails verifyEvent with 401", async () => {
    verifyEventMock.mockReturnValue(false);

    const res = createResponse();
    await handler(makeRequest(), res as any);

    expect(res.statusCode).toBe(401);
    expect(res.jsonBody).toEqual({ error: "Invalid signed event" });
    expect(isMcpRequestProofFreshMock).not.toHaveBeenCalled();
    expectNoRead();
  });

  it("rejects an event with the wrong kind with 401", async () => {
    parseSignedEventHeaderMock.mockReturnValue({
      kind: MCP_REQUEST_PROOF_KIND + 1,
      pubkey: SELLER_PUBKEY,
      tags: [
        ["action", "shipping_list_labels"],
        ["path", "/api/shipping/labels"],
      ],
    });

    const res = createResponse();
    await handler(makeRequest(), res as any);

    expect(res.statusCode).toBe(401);
    expect(res.jsonBody).toEqual({ error: "Invalid signed event" });
    expect(verifyEventMock).not.toHaveBeenCalled();
    expect(isMcpRequestProofFreshMock).not.toHaveBeenCalled();
    expectNoRead();
  });

  it("rejects a stale (expired) event with 401", async () => {
    isMcpRequestProofFreshMock.mockReturnValue(false);

    const res = createResponse();
    await handler(makeRequest(), res as any);

    expect(res.statusCode).toBe(401);
    expect(res.jsonBody).toEqual({ error: "Signed event expired" });
    expectNoRead();
  });

  it("rejects a proof bound to a different endpoint path with 401", async () => {
    parseSignedEventHeaderMock.mockReturnValue({
      kind: MCP_REQUEST_PROOF_KIND,
      pubkey: SELLER_PUBKEY,
      tags: [
        ["action", "shipping_list_labels"],
        ["path", "/api/shipping/buy-label"],
      ],
    });

    const res = createResponse();
    await handler(makeRequest(), res as any);

    expect(res.statusCode).toBe(401);
    expect(res.jsonBody).toEqual({
      error: "Signed event does not match request",
    });
    expectNoRead();
  });

  it("rejects a proof carrying a different action with 401", async () => {
    parseSignedEventHeaderMock.mockReturnValue({
      kind: MCP_REQUEST_PROOF_KIND,
      pubkey: SELLER_PUBKEY,
      tags: [
        ["action", "shipping_buy_label"],
        ["path", "/api/shipping/labels"],
      ],
    });

    const res = createResponse();
    await handler(makeRequest(), res as any);

    expect(res.statusCode).toBe(401);
    expect(res.jsonBody).toEqual({
      error: "Signed event does not match request",
    });
    expectNoRead();
  });
});
