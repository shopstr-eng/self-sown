/** @jest-environment node */

/**
 * Audience gate for POST /api/mcp/api-keys.
 *
 * API keys are audience-split, not permission-split:
 * - "shopping" keys are free for ANY pubkey — no Pro entitlement check at
 *   creation (or per request; that half is pinned in utils/mcp auth tests).
 * - "seller" keys stay Pro-gated at creation.
 * - Requests that omit `audience` keep the legacy behavior: a seller key at
 *   the requested permissions tier, Pro-gated.
 */

import type { NextApiRequest, NextApiResponse } from "next";

const mockApplyRateLimit = jest.fn();
const mockInitializeApiKeysTable = jest.fn();
const mockCreateApiKey = jest.fn();
const mockResolveBearerSessionAuth = jest.fn();
const mockRequireProEntitlement = jest.fn();

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: (...args: any[]) => mockApplyRateLimit(...args),
}));

jest.mock("@/utils/mcp/auth", () => ({
  initializeApiKeysTable: (...args: any[]) =>
    mockInitializeApiKeysTable(...args),
  createApiKey: (...args: any[]) => mockCreateApiKey(...args),
  listApiKeys: jest.fn(async () => []),
  revokeApiKey: jest.fn(async () => true),
}));

jest.mock("@/utils/assistant/session-auth", () => ({
  resolveBearerSessionAuth: (...args: any[]) =>
    mockResolveBearerSessionAuth(...args),
}));

jest.mock("@/utils/pro/require-pro", () => ({
  requireProEntitlement: (...args: any[]) => mockRequireProEntitlement(...args),
}));

import handler from "@/pages/api/mcp/api-keys";

const PUBKEY = "c".repeat(64);

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
  } as unknown as NextApiResponse & { status: jest.Mock; json: jest.Mock };
}

function makeReq(body: Record<string, unknown>) {
  return {
    method: "POST",
    headers: { host: "localhost" },
    body,
  } as unknown as NextApiRequest;
}

describe("POST /api/mcp/api-keys audience gate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApplyRateLimit.mockResolvedValue(true);
    mockInitializeApiKeysTable.mockResolvedValue(undefined);
    // Session token verifies — no per-request signing prompt needed.
    mockResolveBearerSessionAuth.mockResolvedValue({ ok: true });
    mockCreateApiKey.mockImplementation(
      async (
        name: string,
        pubkey: string,
        permissions: string,
        _nsec: unknown,
        audience: string
      ) => ({
        key: "sk_new",
        record: {
          id: 42,
          key_prefix: "sk_new",
          name,
          pubkey,
          permissions,
          audience,
          created_at: "",
          last_used_at: null,
          is_active: true,
        },
      })
    );
    // Mirrors the real helper: writes the 403 itself and returns false.
    mockRequireProEntitlement.mockImplementation(
      async (_pubkey: string, res: any) => {
        res.status(403).json({ error: "Herd membership required" });
        return false;
      }
    );
  });

  it("creates a free shopping key for a non-Pro pubkey without a Pro check", async () => {
    const res = makeRes();
    await handler(
      makeReq({ name: "Shopper", pubkey: PUBKEY, audience: "shopping" }),
      res
    );

    expect(mockRequireProEntitlement).not.toHaveBeenCalled();
    expect(mockCreateApiKey).toHaveBeenCalledWith(
      "Shopper",
      PUBKEY,
      "read",
      undefined,
      "shopping"
    );
    expect(res.status).toHaveBeenCalledWith(201);
    const body = res.json.mock.calls[0]![0];
    expect(body.audience).toBe("shopping");
  });

  it("rejects seller key creation when the pubkey is not Pro-entitled", async () => {
    const res = makeRes();
    await handler(
      makeReq({ name: "Seller", pubkey: PUBKEY, audience: "seller" }),
      res
    );

    expect(mockRequireProEntitlement).toHaveBeenCalledWith(PUBKEY, res);
    expect(mockCreateApiKey).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("creates a seller key with full seller tooling when Pro-entitled", async () => {
    mockRequireProEntitlement.mockResolvedValue(true);
    const res = makeRes();
    await handler(
      makeReq({ name: "Seller", pubkey: PUBKEY, audience: "seller" }),
      res
    );

    expect(mockCreateApiKey).toHaveBeenCalledWith(
      "Seller",
      PUBKEY,
      "full_access",
      undefined,
      "seller"
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("keeps legacy audience-less requests seller-scoped and Pro-gated", async () => {
    const res = makeRes();
    await handler(
      makeReq({ name: "Legacy", pubkey: PUBKEY, permissions: "read_write" }),
      res
    );

    expect(mockRequireProEntitlement).toHaveBeenCalled();
    expect(mockCreateApiKey).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("rejects an unknown audience value", async () => {
    const res = makeRes();
    await handler(
      makeReq({ name: "X", pubkey: PUBKEY, audience: "admin" }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockCreateApiKey).not.toHaveBeenCalled();
  });
});
