/**
 * @jest-environment node
 *
 * Signed-event (cryptographic proof) rejection coverage for the parcel-template
 * endpoint (GET/POST/DELETE /api/shipping/parcel-templates).
 *
 * This endpoint lists, upserts, and deletes a seller's saved parcel templates.
 * The 401 guard must reject a missing, malformed, forged, wrong-kind, expired,
 * or mismatched signed event BEFORE any DB read or write. Every test proves the
 * guard short-circuits before listParcelTemplatesForPubkey / upsertParcelTemplate
 * / deleteParcelTemplate are ever called, so an unauthorized caller can neither
 * read nor mutate another seller's templates.
 */

const MCP_SIGNED_EVENT_HEADER = "x-mcp-signed-event";
const MCP_REQUEST_PROOF_KIND = 27235;

const applyRateLimitMock = jest.fn();
const isMcpRequestProofFreshMock = jest.fn();
const parseSignedEventHeaderMock = jest.fn();
const verifyEventMock = jest.fn();
const listParcelTemplatesForPubkeyMock = jest.fn();
const upsertParcelTemplateMock = jest.fn();
const deleteParcelTemplateMock = jest.fn();

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
  listParcelTemplatesForPubkey: (...args: unknown[]) =>
    listParcelTemplatesForPubkeyMock(...args),
  upsertParcelTemplate: (...args: unknown[]) =>
    upsertParcelTemplateMock(...args),
  deleteParcelTemplate: (...args: unknown[]) =>
    deleteParcelTemplateMock(...args),
}));

import handler from "@/pages/api/shipping/parcel-templates";

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

// Guards are exercised against POST (an upsert write) unless a test overrides
// the method. The proof's "method" tag must match req.method.
function makeRequest(
  method = "POST",
  body: Record<string, unknown> = { name: "Small Box", weightOz: 16 }
) {
  return {
    method,
    headers: { [MCP_SIGNED_EVENT_HEADER]: "signed-event-header" },
    body,
    query: {},
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
      ["path", "/api/shipping/parcel-templates"],
      ["method", "POST"],
    ],
  });
  listParcelTemplatesForPubkeyMock.mockResolvedValue([{ id: 1 }]);
  upsertParcelTemplateMock.mockResolvedValue({ id: 1 });
  deleteParcelTemplateMock.mockResolvedValue(true);
});

describe("/api/shipping/parcel-templates signed-event (cryptographic proof) guards", () => {
  // The 401 guard runs BEFORE any DB read/write, so a forged / missing /
  // expired / mismatched signature must never touch the templates table.
  function expectNoDb() {
    expect(listParcelTemplatesForPubkeyMock).not.toHaveBeenCalled();
    expect(upsertParcelTemplateMock).not.toHaveBeenCalled();
    expect(deleteParcelTemplateMock).not.toHaveBeenCalled();
  }

  it("accepts a valid POST signed event and upserts the template", async () => {
    const res = createResponse();
    await handler(makeRequest(), res as any);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toMatchObject({ success: true });
    expect(upsertParcelTemplateMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a request with no signed-event header with 401", async () => {
    const req = {
      method: "POST",
      headers: {},
      body: { name: "Small Box", weightOz: 16 },
      query: {},
    } as any;
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
        ["path", "/api/shipping/parcel-templates"],
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
        ["path", "/api/shipping/defaults"],
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
    // Proof was signed for a GET (list), but replayed against a DELETE.
    parseSignedEventHeaderMock.mockReturnValue({
      kind: MCP_REQUEST_PROOF_KIND,
      pubkey: SELLER_PUBKEY,
      tags: [
        ["path", "/api/shipping/parcel-templates"],
        ["method", "GET"],
      ],
    });

    const res = createResponse();
    await handler(makeRequest("DELETE", { id: 5 }), res as any);

    expect(res.statusCode).toBe(401);
    expect(res.jsonBody).toEqual({
      error: "Signed event does not match request",
    });
    expectNoDb();
  });
});
