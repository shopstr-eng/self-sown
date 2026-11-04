/** @jest-environment node */

// Route-level coverage for pages/api/square/oauth/start.ts. Pinned here:
//   1. The OAuth state round-trips verbatim through createSquareOAuthState
//      into the authorize URL (the callback consumes it by exact match).
//   2. Mobile app flows (app: true) get an "app_" state prefix — the marker
//      /square-oauth-redirect uses to bounce back into the app scheme.
//   3. The bidirectional Stripe/Square XOR refuses to start while a Stripe
//      Connect account exists.
//   4. Mobile clients authenticate with a NIP-98-style seller-action event
//      when the MCP request proof doesn't verify (same fallback as Stripe).
//   5. Unconfigured deployments fail closed with 503.

jest.mock("@/utils/mcp/request-proof-server", () => ({
  verifyAndConsumeSignedRequestProof: jest.fn(async () => ({ ok: true })),
}));

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn(async () => true),
}));

jest.mock("@/utils/db/square-service", () => ({
  createSquareOAuthState: jest.fn(async () => undefined),
}));

jest.mock("@/utils/db/db-service", () => ({
  getStripeConnectAccount: jest.fn(async () => null),
}));

jest.mock("@/utils/stripe/verify-nostr-auth", () => ({
  verifyNostrAuth: jest.fn(() => ({ valid: false, pubkey: "", error: "no" })),
}));

import handler from "@/pages/api/square/oauth/start";
import { verifyAndConsumeSignedRequestProof } from "@/utils/mcp/request-proof-server";
import { createSquareOAuthState } from "@/utils/db/square-service";
import { getStripeConnectAccount } from "@/utils/db/db-service";
import { verifyNostrAuth } from "@/utils/stripe/verify-nostr-auth";

const PUBKEY = "a".repeat(64);

const mockVerifyProof = verifyAndConsumeSignedRequestProof as jest.Mock;
const mockCreateState = createSquareOAuthState as jest.Mock;
const mockGetStripe = getStripeConnectAccount as jest.Mock;
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

async function callHandler(body: Record<string, unknown>) {
  const res = makeRes();
  await handler({ method: "POST", body, headers: {} } as any, res as any);
  return res;
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.SQUARE_OAUTH_CLIENT_ID = "sq-app-1";
  process.env.SQUARE_OAUTH_CLIENT_SECRET = "sq-secret-1";
  process.env.SQUARE_ENVIRONMENT = "sandbox";
  process.env.NEXT_PUBLIC_BASE_URL = "https://platform.example.com";
  mockVerifyProof.mockResolvedValue({ ok: true });
  mockGetStripe.mockResolvedValue(null);
  mockVerifyNostr.mockReturnValue({ valid: false, pubkey: "", error: "no" });
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe("POST /api/square/oauth/start", () => {
  it("returns a Square authorize URL with a server-stored state bound to the pubkey", async () => {
    const res = await callHandler({ pubkey: PUBKEY });
    expect(res.statusCode).toBe(200);
    const url = new URL((res.body as any).authorizeUrl);
    expect(url.origin + url.pathname).toBe(
      "https://connect.squareupsandbox.com/oauth2/authorize"
    );
    expect(url.searchParams.get("client_id")).toBe("sq-app-1");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://platform.example.com/square-oauth-redirect"
    );
    const state = url.searchParams.get("state") || "";
    expect(state).not.toMatch(/^app_/);
    // The exact state string is what the callback consumes — it must be the
    // one stored server-side.
    expect(mockCreateState).toHaveBeenCalledWith(
      PUBKEY,
      state,
      "https://platform.example.com/square-oauth-redirect"
    );
  });

  it("marks the state with the app_ prefix when the mobile app starts the flow", async () => {
    const res = await callHandler({ pubkey: PUBKEY, app: true });
    expect(res.statusCode).toBe(200);
    const url = new URL((res.body as any).authorizeUrl);
    const state = url.searchParams.get("state") || "";
    expect(state).toMatch(/^app_[0-9a-f]{48}$/);
    expect(mockCreateState).toHaveBeenCalledWith(
      PUBKEY,
      state,
      expect.any(String)
    );
  });

  it("refuses to start while a Stripe Connect account exists (bidirectional XOR)", async () => {
    mockGetStripe.mockResolvedValue({ stripe_account_id: "acct_1" });
    const res = await callHandler({ pubkey: PUBKEY });
    expect(res.statusCode).toBe(409);
    expect((res.body as any).code).toBe("stripe_connected");
    expect(mockCreateState).not.toHaveBeenCalled();
  });

  it("accepts a mobile seller-action auth event when the MCP proof doesn't verify", async () => {
    mockVerifyProof.mockResolvedValue({
      ok: false,
      status: 401,
      error: "bad proof",
    });
    mockVerifyNostr.mockReturnValue({ valid: true, pubkey: PUBKEY });
    const signedEvent = { kind: 27235 };
    const res = await callHandler({ pubkey: PUBKEY, signedEvent });
    expect(res.statusCode).toBe(200);
    expect(mockVerifyNostr).toHaveBeenCalledWith(
      signedEvent,
      PUBKEY,
      "square-oauth",
      { method: "POST", path: "/api/square/oauth/start" }
    );
  });

  it("rejects when neither the MCP proof nor the seller-action event verifies", async () => {
    mockVerifyProof.mockResolvedValue({
      ok: false,
      status: 401,
      error: "bad proof",
    });
    const res = await callHandler({ pubkey: PUBKEY });
    expect(res.statusCode).toBe(401);
    expect(mockCreateState).not.toHaveBeenCalled();
  });

  it("fails closed with 503 when Square isn't configured", async () => {
    delete process.env.SQUARE_ENVIRONMENT;
    const res = await callHandler({ pubkey: PUBKEY });
    expect(res.statusCode).toBe(503);
    expect((res.body as any).authorizeUrl).toBeUndefined();
  });
});
