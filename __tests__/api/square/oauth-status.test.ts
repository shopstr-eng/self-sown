/** @jest-environment node */

// Route-level coverage for pages/api/square/oauth/status.ts, focused on the
// mobile auth fallback: the app dashboard reads this endpoint with a
// NIP-98-style seller-action event when the MCP request proof doesn't verify
// (same fallback as the Stripe connect routes). Also pins the fail-closed
// "not configured" response the mobile UI keys off to hide the Square card.

jest.mock("@/utils/mcp/request-proof-server", () => ({
  verifyAndConsumeSignedRequestProof: jest.fn(async () => ({ ok: true })),
}));

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn(async () => true),
}));

jest.mock("@/utils/db/square-service", () => ({
  getSquareConnection: jest.fn(async () => null),
}));

jest.mock("@/utils/stripe/verify-nostr-auth", () => ({
  verifyNostrAuth: jest.fn(() => ({ valid: false, pubkey: "", error: "no" })),
}));

import handler from "@/pages/api/square/oauth/status";
import { verifyAndConsumeSignedRequestProof } from "@/utils/mcp/request-proof-server";
import { getSquareConnection } from "@/utils/db/square-service";
import { verifyNostrAuth } from "@/utils/stripe/verify-nostr-auth";

const PUBKEY = "a".repeat(64);

const mockVerifyProof = verifyAndConsumeSignedRequestProof as jest.Mock;
const mockGetConnection = getSquareConnection as jest.Mock;
const mockVerifyNostr = verifyNostrAuth as jest.Mock;

function makeRes() {
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
  return res;
}

async function callHandler() {
  const res = makeRes();
  await handler(
    { method: "GET", query: { pubkey: PUBKEY }, headers: {} } as any,
    res as any
  );
  return res;
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.SQUARE_OAUTH_CLIENT_ID = "sq-app-1";
  process.env.SQUARE_OAUTH_CLIENT_SECRET = "sq-secret-1";
  process.env.SQUARE_ENVIRONMENT = "sandbox";
  mockVerifyProof.mockResolvedValue({ ok: true });
  mockGetConnection.mockResolvedValue(null);
  mockVerifyNostr.mockReturnValue({ valid: false, pubkey: "", error: "no" });
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe("GET /api/square/oauth/status", () => {
  it("reports the stored connection", async () => {
    mockGetConnection.mockResolvedValue({
      merchantId: "m1",
      locationId: "l1",
      locationCurrency: "USD",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const res = await callHandler();
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      configured: true,
      connected: true,
      environment: "sandbox",
      merchantId: "m1",
      currency: "USD",
    });
  });

  it("reports not-configured without touching the database", async () => {
    delete process.env.SQUARE_ENVIRONMENT;
    const res = await callHandler();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ configured: false, connected: false });
    expect(mockGetConnection).not.toHaveBeenCalled();
  });

  it("accepts a mobile seller-action auth event when the MCP proof doesn't verify", async () => {
    mockVerifyProof.mockResolvedValue({
      ok: false,
      status: 401,
      error: "bad proof",
    });
    mockVerifyNostr.mockReturnValue({ valid: true, pubkey: PUBKEY });
    const res = await callHandler();
    expect(res.statusCode).toBe(200);
    expect(mockVerifyNostr).toHaveBeenCalledWith(
      undefined,
      PUBKEY,
      "square-oauth",
      { method: "GET", path: "/api/square/oauth/status" }
    );
  });

  it("rejects when neither the MCP proof nor the seller-action event verifies", async () => {
    mockVerifyProof.mockResolvedValue({
      ok: false,
      status: 401,
      error: "bad proof",
    });
    const res = await callHandler();
    expect(res.statusCode).toBe(401);
    expect(mockGetConnection).not.toHaveBeenCalled();
  });
});
