/** @jest-environment node */

// Route-level coverage for pages/api/stripe/connect/standard/start.ts.
// Standard Connect is OAuth: the seller links their OWN full Stripe account.
// The endpoint returns Stripe's authorize URL with an HMAC-signed state token
// that binds the unauthenticated callback back to this seller. Pinned here:
//   1. Configured deployments get a well-formed authorize URL whose state
//      round-trips to the requesting pubkey.
//   2. Unconfigured deployments fail closed with 503 (never emit a URL that
//      would just error at Stripe).

jest.mock("@/utils/mcp/request-proof-server", () => ({
  extractSignedEventFromRequest: jest.fn(() => null),
  verifyAndConsumeSignedRequestProof: jest.fn(async () => ({ ok: true })),
}));

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn(async () => true),
}));

import handler from "@/pages/api/stripe/connect/standard/start";
import { verifyOAuthState } from "@/utils/stripe/standard-oauth";

const PUBKEY = "a".repeat(64);

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
  await handler({ method: "POST", body } as any, res as any);
  return res;
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret";
  process.env.STRIPE_SECRET_KEY = "sk_test_1";
  process.env.STRIPE_CLIENT_ID = "ca_test_1";
  process.env.NEXT_PUBLIC_BASE_URL = "https://milk.market";
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe("POST /api/stripe/connect/standard/start", () => {
  it("returns a Stripe authorize URL whose signed state binds the pubkey", async () => {
    const res = await callHandler({ pubkey: PUBKEY });
    expect(res.statusCode).toBe(200);
    const url = new URL((res.body as any).url);
    expect(url.origin + url.pathname).toBe(
      "https://connect.stripe.com/oauth/authorize"
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("ca_test_1");
    expect(url.searchParams.get("scope")).toBe("read_write");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://milk.market/api/stripe/connect/standard/callback"
    );
    const state = url.searchParams.get("state") || "";
    expect(verifyOAuthState(state)).toBe(PUBKEY);
  });

  it("fails closed with 503 when the deployment hasn't configured Standard Connect", async () => {
    delete process.env.STRIPE_CLIENT_ID;
    const res = await callHandler({ pubkey: PUBKEY });
    expect(res.statusCode).toBe(503);
    expect((res.body as any).code).toBe("standard_connect_not_configured");
    expect((res.body as any).url).toBeUndefined();
  });

  it("rejects a missing pubkey", async () => {
    const res = await callHandler({});
    expect(res.statusCode).toBe(400);
  });
});
