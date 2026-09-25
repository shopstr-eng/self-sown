// Route tests for the assistant session flow: /api/assistant/session mints a
// short-lived bearer token from one NIP-98 signature, and /api/assistant/chat
// accepts that token so NIP-07/NIP-46 users approve once per window instead of
// once per message. Module seams are mocked like seller-assistant.test.ts; the
// session-token util runs for real (keyed by a test SESSION_SECRET).

const applyRateLimitMock = jest.fn();
const verifyNip98RequestMock = jest.fn();
const requireProEntitlementMock = jest.fn();
const fetchShopProfileMock = jest.fn();
const ensureAssistantTablesMock = jest.fn();
const getOrCreateAssistantKeyMock = jest.fn();
const getAssistantSigningStateMock = jest.fn();
const getAssistantRawKeyMock = jest.fn();
const runSellerAssistantMock = jest.fn();
const mcpConnectMock = jest.fn();
const mcpCloseMock = jest.fn();

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

jest.mock("@/utils/db/db-service", () => ({
  // db-service mocks must provide getDbPool: other utils/db modules call it
  // at module scope and a bare mock breaks the whole suite at import time.
  getDbPool: jest.fn(),
  fetchShopProfileByPubkeyFromDb: (...args: unknown[]) =>
    fetchShopProfileMock(...args),
}));

jest.mock("@/utils/pro/membership", () => ({
  isPubkeyProEntitled: jest.fn().mockResolvedValue(false),
}));

jest.mock("@/utils/assistant/assistant-key", () => ({
  ensureAssistantTables: (...args: unknown[]) =>
    ensureAssistantTablesMock(...args),
  getOrCreateAssistantKey: (...args: unknown[]) =>
    getOrCreateAssistantKeyMock(...args),
  getAssistantSigningState: (...args: unknown[]) =>
    getAssistantSigningStateMock(...args),
  getAssistantRawKey: (...args: unknown[]) => getAssistantRawKeyMock(...args),
  invalidateAssistantRawKey: () => undefined,
}));

jest.mock("@/utils/assistant/mcp-client", () => {
  const actual = jest.requireActual("@/utils/assistant/mcp-client");
  return {
    ...actual,
    McpLoopbackClient: jest.fn().mockImplementation(() => ({
      connect: mcpConnectMock,
      close: mcpCloseMock,
    })),
  };
});

jest.mock("@/utils/assistant/agent", () => {
  const actual = jest.requireActual("@/utils/assistant/agent");
  return {
    ...actual,
    runSellerAssistant: (...args: unknown[]) => runSellerAssistantMock(...args),
  };
});

import type { NextApiRequest, NextApiResponse } from "next";
import chatHandler from "@/pages/api/assistant/chat";
import sessionHandler from "@/pages/api/assistant/session";
import {
  mintAssistantSessionToken,
  verifyAssistantSessionToken,
} from "@/utils/assistant/session-token";

const SELLER_PUBKEY = "c".repeat(64);

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
    headers: { authorization: "Nostr abc" },
    body: {},
    ...overrides,
  } as unknown as NextApiRequest;
}

function createChatReq(token: string) {
  return createReq({
    headers: { authorization: `Bearer ${token}` },
    body: { messages: [{ role: "user", content: "How many orders today?" }] },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  applyRateLimitMock.mockResolvedValue(true);
  verifyNip98RequestMock.mockResolvedValue({ ok: true, pubkey: SELLER_PUBKEY });
  requireProEntitlementMock.mockResolvedValue(true);
  // No stall profile → buyer toggle off → buyer path 403s by default.
  fetchShopProfileMock.mockResolvedValue(null);
  ensureAssistantTablesMock.mockResolvedValue(undefined);
  getOrCreateAssistantKeyMock.mockResolvedValue({ id: 7 });
  getAssistantSigningStateMock.mockResolvedValue(true);
  getAssistantRawKeyMock.mockResolvedValue("sk_assistant_raw");
  mcpConnectMock.mockResolvedValue(undefined);
  mcpCloseMock.mockResolvedValue(undefined);
  runSellerAssistantMock.mockResolvedValue({
    reply: "You have 3 new orders.",
    actions: [],
  });
});

describe("POST /api/assistant/session", () => {
  it("rejects non-POST methods", async () => {
    const res = createMockRes();
    await sessionHandler(createReq({ method: "GET" }), res);
    expect(res.statusCode).toBe(405);
  });

  it("401s without valid NIP-98 auth", async () => {
    verifyNip98RequestMock.mockResolvedValue({ ok: false, error: "bad sig" });
    const res = createMockRes();
    await sessionHandler(createReq(), res);
    expect(res.statusCode).toBe(401);
  });

  it("403s for non-Pro sellers", async () => {
    requireProEntitlementMock.mockImplementation(async (_pk, res) => {
      res.status(403).json({ error: "Herd feature" });
      return false;
    });
    const res = createMockRes();
    await sessionHandler(createReq(), res);
    expect(res.statusCode).toBe(403);
  });

  it("mints a token that verifies for the signed-in pubkey", async () => {
    const res = createMockRes();
    await sessionHandler(createReq(), res);
    expect(res.statusCode).toBe(200);
    expect(typeof res.body.token).toBe("string");
    expect(res.body.expiresAt).toBeGreaterThan(Date.now());
    expect(verifyAssistantSessionToken(res.body.token)).toEqual({
      pubkey: SELLER_PUBKEY,
      expiresAtMs: res.body.expiresAt,
    });
  });

  it("mints a scoped token that only verifies under that scope", async () => {
    const res = createMockRes();
    await sessionHandler(
      createReq({ body: { scope: "assistant-setup" } }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.scope).toBe("assistant-setup");
    expect(
      verifyAssistantSessionToken(res.body.token, "assistant-setup")
    ).toEqual({
      pubkey: SELLER_PUBKEY,
      expiresAtMs: res.body.expiresAt,
    });
    // Domain separation: the setup token must not verify as a chat token.
    expect(verifyAssistantSessionToken(res.body.token, "chat")).toBeNull();
  });

  it("400s on an unknown scope without minting", async () => {
    const res = createMockRes();
    await sessionHandler(createReq({ body: { scope: "admin" } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.token).toBeUndefined();
  });
});

describe("POST /api/assistant/chat with a session bearer token", () => {
  it("authenticates with the token and skips NIP-98 verification", async () => {
    const { token } = mintAssistantSessionToken(SELLER_PUBKEY);
    const res = createMockRes();
    await chatHandler(createChatReq(token), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.reply).toBe("You have 3 new orders.");
    expect(verifyNip98RequestMock).not.toHaveBeenCalled();
    expect(runSellerAssistantMock).toHaveBeenCalledTimes(1);
    expect(runSellerAssistantMock.mock.calls[0][0].pubkey).toBe(
      SELLER_PUBKEY
    );
  });

  it("is multi-use within its window (no replay-guard claim)", async () => {
    const { token } = mintAssistantSessionToken(SELLER_PUBKEY);
    for (let i = 0; i < 3; i++) {
      const res = createMockRes();
      await chatHandler(createChatReq(token), res);
      expect(res.statusCode).toBe(200);
    }
    expect(runSellerAssistantMock).toHaveBeenCalledTimes(3);
  });

  it("401s on an expired token without touching NIP-98", async () => {
    const { token } = mintAssistantSessionToken(
      SELLER_PUBKEY,
      "chat",
      Date.now() - 60 * 60 * 1000
    );
    const res = createMockRes();
    await chatHandler(createChatReq(token), res);
    expect(res.statusCode).toBe(401);
    expect(verifyNip98RequestMock).not.toHaveBeenCalled();
    expect(runSellerAssistantMock).not.toHaveBeenCalled();
  });

  it("401s on a forged token", async () => {
    const res = createMockRes();
    await chatHandler(createChatReq("forged.token"), res);
    expect(res.statusCode).toBe(401);
    expect(runSellerAssistantMock).not.toHaveBeenCalled();
  });

  it("still enforces the Pro gate and per-seller rate limit for bearer auth", async () => {
    const { token } = mintAssistantSessionToken(SELLER_PUBKEY);
    requireProEntitlementMock.mockImplementation(async (_pk, res) => {
      res.status(403).json({ error: "Herd feature" });
      return false;
    });
    const res = createMockRes();
    await chatHandler(createChatReq(token), res);
    expect(res.statusCode).toBe(403);
    expect(runSellerAssistantMock).not.toHaveBeenCalled();
    expect(applyRateLimitMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "assistant-chat:seller",
      expect.anything(),
      SELLER_PUBKEY
    );
  });

  it("treats a bearer token for another pubkey as a buyer on a custom stall", async () => {
    const stallPubkey = "d".repeat(64);
    const { token } = mintAssistantSessionToken(SELLER_PUBKEY); // ≠ stall owner
    const res = createMockRes();
    await chatHandler(
      createReq({
        headers: { authorization: `Bearer ${token}` },
        body: {
          messages: [{ role: "user", content: "What do you sell?" }],
          context: { stallPubkey },
        },
      }),
      res
    );
    // Buyer path: the seller assistant never runs.
    expect(runSellerAssistantMock).not.toHaveBeenCalled();
  });
});
