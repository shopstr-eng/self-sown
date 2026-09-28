/** @jest-environment node */

/**
 * The proxy stamps a generic advisory `RateLimit-Policy: "agent";q=600;w=60`
 * on every response. Routes that enforce their own budget via applyRateLimit
 * override the numeric RateLimit-* headers but previously left that advisory
 * policy header in place, so e.g. POST /api/assistant/chat advertised 600/60s
 * while actually enforcing 20/hr. This pins applyRateLimit's RateLimit-Policy
 * override to the bucket's real limit/window.
 */

jest.mock("@/utils/db/db-service", () => ({
  // db-service builds its pool at module scope; the mock must still expose it
  // or unrelated suites importing db-service die at import time.
  getDbPool: jest.fn(),
  // Force the in-memory fallback so the test needs no database.
  incrementRateLimitCounter: jest.fn(() =>
    Promise.reject(new Error("no shared store in unit test"))
  ),
  cleanupExpiredRateLimitCounters: jest.fn(() => Promise.resolve()),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import { applyRateLimit, __resetRateLimitBuckets } from "@/utils/rate-limit";

function fakeReq(): NextApiRequest {
  return {
    socket: { remoteAddress: "203.0.113.10" },
    headers: {},
  } as unknown as NextApiRequest;
}

function fakeRes() {
  const res = {
    setHeader: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res as unknown as NextApiResponse & {
    setHeader: jest.Mock;
    status: jest.Mock;
  };
}

// Mirrors the BUYER_LIMIT enforced in pages/api/assistant/chat.ts.
const BUYER_LIMIT = { limit: 20, windowMs: 60 * 60 * 1000 };

describe("applyRateLimit RateLimit-Policy header", () => {
  beforeEach(() => {
    __resetRateLimitBuckets();
  });

  it("advertises the enforced limit/window, not the proxy's advisory policy", async () => {
    const res = fakeRes();
    const allowed = await applyRateLimit(
      fakeReq(),
      res,
      "assistant-chat:buyer",
      BUYER_LIMIT
    );

    expect(allowed).toBe(true);
    expect(res.setHeader).toHaveBeenCalledWith(
      "RateLimit-Policy",
      '"assistant-chat:buyer";q=20;w=3600'
    );
    expect(res.setHeader).toHaveBeenCalledWith("RateLimit-Limit", "20");
  });

  it("still advertises the real policy on the 429 response", async () => {
    const bucket = "assistant-chat:buyer-429";
    const tiny = { limit: 1, windowMs: 60 * 1000 };
    expect(await applyRateLimit(fakeReq(), fakeRes(), bucket, tiny)).toBe(true);

    const res = fakeRes();
    expect(await applyRateLimit(fakeReq(), res, bucket, tiny)).toBe(false);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.setHeader).toHaveBeenCalledWith(
      "RateLimit-Policy",
      '"assistant-chat:buyer-429";q=1;w=60'
    );
  });
});
