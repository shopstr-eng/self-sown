// Route tests for scoped session bearer tokens on the assistant setup route
// and the MCP API-key management route: one NIP-98 signature mints a
// scope-limited token at /api/assistant/session, and those endpoints accept
// it so NIP-07/NIP-46 users approve once per window instead of once per
// interaction. Tokens are scope-locked — chat tokens never work here.

const applyRateLimitMock = jest.fn();
const verifyNip98RequestMock = jest.fn();
const requireProEntitlementMock = jest.fn();
const ensureAssistantTablesMock = jest.fn();
const getOrCreateAssistantKeyMock = jest.fn();
const getAssistantSigningStateMock = jest.fn();
const provisionAssistantSigningMock = jest.fn();
const initializeApiKeysTableMock = jest.fn();
const createApiKeyMock = jest.fn();
const listApiKeysMock = jest.fn();
const revokeApiKeyMock = jest.fn();
const verifyAndConsumeProofMock = jest.fn();

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: (...args: unknown[]) => applyRateLimitMock(...args),
  getRequestIp: () => "127.0.0.1",
}));

jest.mock("@/utils/nostr/nip98-auth", () => ({
  verifyNip98Request: (...args: unknown[]) => verifyNip98RequestMock(...args),
}));

jest.mock("@/utils/pro/require-pro", () => ({
  requireProEntitlement: (...args: unknown[]) =>
    requireProEntitlementMock(...args),
}));

jest.mock("@/utils/assistant/assistant-key", () => ({
  ensureAssistantTables: (...args: unknown[]) =>
    ensureAssistantTablesMock(...args),
  getOrCreateAssistantKey: (...args: unknown[]) =>
    getOrCreateAssistantKeyMock(...args),
  getAssistantSigningState: (...args: unknown[]) =>
    getAssistantSigningStateMock(...args),
  provisionAssistantSigning: (...args: unknown[]) =>
    provisionAssistantSigningMock(...args),
}));

jest.mock("@/utils/mcp/auth", () => ({
  initializeApiKeysTable: (...args: unknown[]) =>
    initializeApiKeysTableMock(...args),
  createApiKey: (...args: unknown[]) => createApiKeyMock(...args),
  listApiKeys: (...args: unknown[]) => listApiKeysMock(...args),
  revokeApiKey: (...args: unknown[]) => revokeApiKeyMock(...args),
}));

jest.mock("@/utils/mcp/request-proof-server", () => {
  const actual = jest.requireActual("@/utils/mcp/request-proof-server");
  return {
    ...actual,
    verifyAndConsumeSignedRequestProof: (...args: unknown[]) =>
      verifyAndConsumeProofMock(...args),
  };
});

jest.mock("@/utils/db/db-service", () => ({
  // db-service mocks must provide getDbPool: other utils/db modules call it
  // at module scope and a bare mock breaks the whole suite at import time.
  getDbPool: jest.fn(),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import setupHandler from "@/pages/api/assistant/setup";
import apiKeysHandler from "@/pages/api/mcp/api-keys";
import { mintAssistantSessionToken } from "@/utils/assistant/session-token";

const SELLER_PUBKEY = "c".repeat(64);
const OTHER_PUBKEY = "d".repeat(64);

process.env.SESSION_SECRET = "test-session-secret-with-plenty-of-chars";

function createMockRes() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as NextApiResponse & { statusCode: number; body: any };
}

function createReq(overrides: Partial<NextApiRequest> = {}) {
  return {
    method: "POST",
    headers: {},
    body: {},
    query: {},
    ...overrides,
  } as unknown as NextApiRequest;
}

function bearerReq(
  token: string,
  overrides: Partial<NextApiRequest> = {}
) {
  return createReq({
    ...overrides,
    headers: { authorization: `Bearer ${token}` },
  });
}

// A NIP-98-looking header carrying a stable event id, so the in-process
// replay guard can observe repeat use.
function nip98Header(eventId: string) {
  return `Nostr ${Buffer.from(JSON.stringify({ id: eventId })).toString(
    "base64"
  )}`;
}

beforeEach(() => {
  jest.clearAllMocks();
  applyRateLimitMock.mockResolvedValue(true);
  verifyNip98RequestMock.mockResolvedValue({ ok: true, pubkey: SELLER_PUBKEY });
  requireProEntitlementMock.mockResolvedValue(true);
  ensureAssistantTablesMock.mockResolvedValue(undefined);
  getOrCreateAssistantKeyMock.mockResolvedValue({ id: 7 });
  getAssistantSigningStateMock.mockResolvedValue(true);
  provisionAssistantSigningMock.mockResolvedValue({ ok: true });
  initializeApiKeysTableMock.mockResolvedValue(undefined);
  createApiKeyMock.mockResolvedValue({
    key: "ss_created",
    record: {
      id: 3,
      name: "My Agent",
      permissions: "read",
      key_prefix: "ss_cre",
    },
  });
  listApiKeysMock.mockResolvedValue([]);
  revokeApiKeyMock.mockResolvedValue(true);
  verifyAndConsumeProofMock.mockResolvedValue({ ok: true, status: 200 });
});

describe("GET/POST /api/assistant/setup with a scoped bearer token", () => {
  it("accepts an assistant-setup token for the GET status check", async () => {
    const { token } = mintAssistantSessionToken(SELLER_PUBKEY, "assistant-setup");
    const res = createMockRes();
    await setupHandler(bearerReq(token, { method: "GET" }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.writesEnabled).toBe(true);
    expect(verifyNip98RequestMock).not.toHaveBeenCalled();
  });

  it("accepts an assistant-setup token for the POST provisioning", async () => {
    const { token } = mintAssistantSessionToken(SELLER_PUBKEY, "assistant-setup");
    const res = createMockRes();
    await setupHandler(
      bearerReq(token, { body: { nsec: "nsec1test" } }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(provisionAssistantSigningMock).toHaveBeenCalledWith(
      SELLER_PUBKEY,
      "nsec1test"
    );
    expect(verifyNip98RequestMock).not.toHaveBeenCalled();
  });

  it("bearer tokens are multi-use within their window (no replay claim)", async () => {
    const { token } = mintAssistantSessionToken(SELLER_PUBKEY, "assistant-setup");
    for (let i = 0; i < 2; i++) {
      const res = createMockRes();
      await setupHandler(
        bearerReq(token, { body: { nsec: "nsec1test" } }),
        res
      );
      expect(res.statusCode).toBe(200);
    }
    expect(provisionAssistantSigningMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a chat-scoped token on the setup route", async () => {
    const { token } = mintAssistantSessionToken(SELLER_PUBKEY, "chat");
    for (const method of ["GET", "POST"] as const) {
      const res = createMockRes();
      await setupHandler(
        bearerReq(token, { method, body: { nsec: "nsec1test" } }),
        res
      );
      expect(res.statusCode).toBe(401);
    }
    expect(provisionAssistantSigningMock).not.toHaveBeenCalled();
  });

  it("still enforces the single-use replay guard on NIP-98 POSTs", async () => {
    const req = () =>
      createReq({
        headers: { authorization: nip98Header("setup-event-1") },
        body: { nsec: "nsec1test" },
      });
    const first = createMockRes();
    await setupHandler(req(), first);
    expect(first.statusCode).toBe(200);

    const second = createMockRes();
    await setupHandler(req(), second);
    expect(second.statusCode).toBe(401);
    expect(provisionAssistantSigningMock).toHaveBeenCalledTimes(1);
  });
});

describe("/api/mcp/api-keys with a scoped bearer token", () => {
  it("lists keys with an mcp-keys token, skipping the signed-proof path", async () => {
    const { token } = mintAssistantSessionToken(SELLER_PUBKEY, "mcp-keys");
    const res = createMockRes();
    await apiKeysHandler(
      bearerReq(token, {
        method: "GET",
        query: { pubkey: SELLER_PUBKEY },
      }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(listApiKeysMock).toHaveBeenCalledWith(SELLER_PUBKEY);
    expect(verifyAndConsumeProofMock).not.toHaveBeenCalled();
  });

  it("creates a key with an mcp-keys token", async () => {
    const { token } = mintAssistantSessionToken(SELLER_PUBKEY, "mcp-keys");
    const res = createMockRes();
    await apiKeysHandler(
      bearerReq(token, {
        method: "POST",
        body: { name: "My Agent", permissions: "read", pubkey: SELLER_PUBKEY },
      }),
      res
    );
    expect(res.statusCode).toBe(201);
    expect(createApiKeyMock).toHaveBeenCalledWith(
      "My Agent",
      SELLER_PUBKEY,
      "read"
    );
    expect(verifyAndConsumeProofMock).not.toHaveBeenCalled();
  });

  it("revokes a key with an mcp-keys token", async () => {
    const { token } = mintAssistantSessionToken(SELLER_PUBKEY, "mcp-keys");
    const res = createMockRes();
    await apiKeysHandler(
      bearerReq(token, {
        method: "DELETE",
        body: { id: 3, pubkey: SELLER_PUBKEY },
      }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(revokeApiKeyMock).toHaveBeenCalledWith(3, SELLER_PUBKEY);
  });

  it("403s when the token pubkey does not match the request pubkey", async () => {
    const { token } = mintAssistantSessionToken(OTHER_PUBKEY, "mcp-keys");
    const res = createMockRes();
    await apiKeysHandler(
      bearerReq(token, {
        method: "GET",
        query: { pubkey: SELLER_PUBKEY },
      }),
      res
    );
    expect(res.statusCode).toBe(403);
    expect(listApiKeysMock).not.toHaveBeenCalled();
  });

  it("rejects chat- and setup-scoped tokens on key management", async () => {
    for (const scope of ["chat", "assistant-setup"] as const) {
      const { token } = mintAssistantSessionToken(SELLER_PUBKEY, scope);
      const res = createMockRes();
      await apiKeysHandler(
        bearerReq(token, {
          method: "GET",
          query: { pubkey: SELLER_PUBKEY },
        }),
        res
      );
      expect(res.statusCode).toBe(401);
    }
    expect(listApiKeysMock).not.toHaveBeenCalled();
  });

  it("still accepts the single-use signed proof path", async () => {
    const res = createMockRes();
    await apiKeysHandler(
      createReq({ method: "GET", query: { pubkey: SELLER_PUBKEY } }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(verifyAndConsumeProofMock).toHaveBeenCalledTimes(1);
    expect(listApiKeysMock).toHaveBeenCalledWith(SELLER_PUBKEY);
  });

  it("propagates signed-proof rejections", async () => {
    verifyAndConsumeProofMock.mockResolvedValue({
      ok: false,
      status: 401,
      error: "Signed request proof has already been used.",
    });
    const res = createMockRes();
    await apiKeysHandler(
      createReq({ method: "GET", query: { pubkey: SELLER_PUBKEY } }),
      res
    );
    expect(res.statusCode).toBe(401);
    expect(listApiKeysMock).not.toHaveBeenCalled();
  });
});
