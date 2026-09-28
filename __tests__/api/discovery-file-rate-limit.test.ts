/** @jest-environment node */

// Regression for the advertised 600/60s rate limit on the agent discovery
// files: /.well-known/ucp and /.well-known/http-message-signatures-directory.
// Both handlers gate on applyRateLimit; these tests drive each handler past
// the ceiling with the REAL limiter (the shared Postgres store is made to
// throw so the deterministic in-memory fallback counts, per the agent-view
// test pattern) and assert the 601st request is rejected with a 429 carrying
// Retry-After, and that the RateLimit-*/RateLimit-Policy headers describe the
// bucket the handler actually enforces — not the generic advisory the proxy
// stamps on /api/mcp* responses.
//
// Scope note: this proves the handler→limiter wiring and the 429/header
// contract via the in-memory fallback path only. The shared Postgres counting
// path itself is exercised separately in utils/__tests__/rate-limit.test.ts.

import type { NextApiRequest, NextApiResponse } from "next";

import { __resetRateLimitBuckets } from "@/utils/rate-limit";

// Force the rate limiter onto its deterministic in-memory fallback.
jest.mock("@/utils/db/db-service", () => ({
  getDbPool: jest.fn(() => {
    throw new Error("db disabled in discovery-file rate-limit test");
  }),
  incrementRateLimitCounter: jest.fn(() => {
    throw new Error("db disabled in discovery-file rate-limit test");
  }),
  cleanupExpiredRateLimitCounters: jest.fn(() => Promise.resolve()),
}));

// --- /.well-known/ucp dependencies (mirrors ucp-discovery-handler.test.ts) ---

jest.mock("@/utils/ucp/seller-host", () => ({
  resolveHostScope: jest.fn(async () => ({
    scope: "seller",
    seller: { pubkey: "ab".repeat(32), npub: "npub1example", name: "Farm" },
    unresolved: false,
  })),
  deriveBaseUrl: jest.fn(() => "https://farm.example"),
}));

jest.mock("@/utils/self-host/config", () => ({
  isSelfHost: jest.fn(() => false),
}));

jest.mock("@/utils/site-url", () => ({
  getSiteUrl: () => "https://self-sown.com",
}));

// --- /.well-known/http-message-signatures-directory dependencies ------------

jest.mock("@/utils/web-bot-auth/keys", () => ({
  getSignatureDirectory: jest.fn(async () => ({
    keys: [
      {
        kty: "OKP",
        crv: "Ed25519",
        x: "dGVzdA",
        kid: "test-key",
        use: "sig",
        key_ops: ["verify"],
        alg: "EdDSA",
      },
    ],
  })),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ucpHandler = require("@/pages/api/.well-known/ucp").default;
const signaturesHandler =
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require("@/pages/api/.well-known/http-message-signatures-directory").default;

const RATE_LIMIT_MAX = 600;

function createResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    send(payload: unknown) {
      this.body = payload;
      return this;
    },
    end() {
      return this;
    },
    setHeader(key: string, value: string) {
      this.headers[key] = value;
      return this;
    },
    getHeader(key: string) {
      return this.headers[key];
    },
  };
}

type Response = ReturnType<typeof createResponse>;

function createRequest(remoteAddress = "203.0.113.1"): NextApiRequest {
  return {
    method: "GET",
    headers: { accept: "application/json" },
    query: {},
    socket: { remoteAddress },
  } as unknown as NextApiRequest;
}

type Handler = (
  req: NextApiRequest,
  res: NextApiResponse
) => Promise<unknown>;

async function call(handler: Handler, req: NextApiRequest): Promise<Response> {
  const res = createResponse();
  await handler(req, res as unknown as NextApiResponse);
  return res;
}

// Fire `n` requests from the same request descriptor, returning every
// response so assertions can inspect the whole walk up to the ceiling.
async function callTimes(
  handler: Handler,
  req: NextApiRequest,
  n: number
): Promise<Response[]> {
  const responses: Response[] = [];
  for (let i = 0; i < n; i++) {
    responses.push(await call(handler, req));
  }
  return responses;
}

describe.each<{ name: string; handler: Handler; bucket: string }>([
  {
    name: "/.well-known/ucp",
    handler: ucpHandler,
    bucket: "ucp-discovery",
  },
  {
    name: "/.well-known/http-message-signatures-directory",
    handler: signaturesHandler,
    bucket: "well-known-signatures",
  },
])("$name — 600/60s rate limit", ({ handler, bucket }) => {
  beforeEach(() => {
    __resetRateLimitBuckets();
    jest.clearAllMocks();
  });

  it("rejects the 601st request in a minute with 429 and Retry-After", async () => {
    const req = createRequest();

    const responses = await callTimes(handler, req, RATE_LIMIT_MAX);
    for (const res of responses) {
      expect(res.statusCode).toBe(200);
    }

    const over = await call(handler, req);
    expect(over.statusCode).toBe(429);

    // The agent must be told when to back off until.
    const retryAfter = Number(over.headers["Retry-After"]);
    expect(Number.isFinite(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);

    const body = over.body as { code?: string; retryAfterSeconds?: number };
    expect(body.code).toBe("rate_limited");
    expect(body.retryAfterSeconds).toBe(retryAfter);

    // A different requester keeps its own budget — the rejection is keyed to
    // the abusive client, not a global outage.
    const other = await call(handler, createRequest("203.0.113.2"));
    expect(other.statusCode).toBe(200);
  });

  it("stamps RateLimit-* headers from the real 600/min bucket, not the proxy advisory", async () => {
    const req = createRequest();

    const first = await call(handler, req);
    expect(first.statusCode).toBe(200);
    // The numeric budget must describe the bucket this handler enforces.
    expect(first.headers["RateLimit-Limit"]).toBe(String(RATE_LIMIT_MAX));
    expect(first.headers["RateLimit-Remaining"]).toBe(
      String(RATE_LIMIT_MAX - 1)
    );
    // The policy is keyed by the handler's own bucket name; a bare proxy
    // advisory (q=600;w=60 on /api/mcp*) carries no bucket identity.
    expect(first.headers["RateLimit-Policy"]).toBe(
      `"${bucket}";q=${RATE_LIMIT_MAX};w=60`
    );
    expect(Number(first.headers["RateLimit-Reset"])).toBeGreaterThanOrEqual(1);
    expect(first.headers["X-RateLimit-Limit"]).toBe(String(RATE_LIMIT_MAX));

    // Walk the rest of the budget; remaining must count down to zero.
    const rest = await callTimes(handler, req, RATE_LIMIT_MAX - 1);
    expect(rest).toHaveLength(RATE_LIMIT_MAX - 1);
    const last = rest[rest.length - 1] as Response;
    expect(last.statusCode).toBe(200);
    expect(last.headers["RateLimit-Remaining"]).toBe("0");

    // Over the limit the headers still describe the same bucket (remaining
    // stays clamped at 0), so a limited agent can schedule a retry.
    const over = await call(handler, req);
    expect(over.statusCode).toBe(429);
    expect(over.headers["RateLimit-Limit"]).toBe(String(RATE_LIMIT_MAX));
    expect(over.headers["RateLimit-Remaining"]).toBe("0");
    expect(over.headers["RateLimit-Policy"]).toBe(
      `"${bucket}";q=${RATE_LIMIT_MAX};w=60`
    );
  });
});
