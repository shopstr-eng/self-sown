/** @jest-environment node */

/**
 * The proxy stamps a generic advisory `RateLimit-Policy: "agent";q=600;w=60`
 * on every response. Routes that call checkRateLimit directly (instead of
 * applyRateLimit) previously set no RateLimit headers of their own — or only
 * the numeric X-RateLimit-* ones — so they advertised the proxy's fictional
 * 600/60s policy while enforcing a different (usually tighter) budget. This
 * pins two previously-uncovered routes to emit a RateLimit-Policy matching
 * the limit/window they actually enforce.
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
  getSellerEmailUnsubscribeCounts: jest.fn(() =>
    Promise.resolve({ unsubscribed: 2, suppressed: 1 })
  ),
  cacheEvents: jest.fn(() => Promise.resolve()),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import { __resetRateLimitBuckets } from "@/utils/rate-limit";
import unsubscribeCountsHandler from "@/pages/api/email/unsubscribe-counts";
import cacheEventsHandler from "@/pages/api/db/cache-events";

function fakeReq(overrides: Record<string, unknown> = {}): NextApiRequest {
  return {
    socket: { remoteAddress: "203.0.113.10" },
    headers: {},
    ...overrides,
  } as unknown as NextApiRequest;
}

function fakeRes() {
  const headers: Record<string, string> = {};
  const res = {
    headers,
    setHeader: jest.fn((name: string, value: string | number) => {
      headers[name] = String(value);
    }),
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res as unknown as NextApiResponse & {
    headers: Record<string, string>;
    status: jest.Mock;
  };
}

describe("direct checkRateLimit routes advertise their real policy", () => {
  beforeEach(() => {
    __resetRateLimitBuckets();
  });

  it("GET /api/email/unsubscribe-counts advertises 60/60s, not 600/60s", async () => {
    const res = fakeRes();
    await unsubscribeCountsHandler(
      fakeReq({ method: "GET", query: { pubkey: "a".repeat(64) } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.headers["RateLimit-Policy"]).toBe(
      '"email-unsubscribe-counts";q=60;w=60'
    );
    expect(res.headers["RateLimit-Limit"]).toBe("60");
  });

  it("POST /api/db/cache-events advertises 300/60s, not 600/60s", async () => {
    const res = fakeRes();
    await cacheEventsHandler(fakeReq({ method: "POST", body: [] }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.headers["RateLimit-Policy"]).toBe('"cache-events";q=300;w=60');
    expect(res.headers["RateLimit-Limit"]).toBe("300");
  });

  it("the 429 response still carries the enforced policy", async () => {
    // unsubscribe-counts allows 60/min; burn the whole bucket, then confirm
    // the rejection still reports the real policy rather than the proxy's.
    const bucketBurn = { method: "GET", query: { pubkey: "a".repeat(64) } };
    for (let i = 0; i < 60; i++) {
      await unsubscribeCountsHandler(fakeReq(bucketBurn), fakeRes());
    }

    const res = fakeRes();
    await unsubscribeCountsHandler(fakeReq(bucketBurn), res);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.headers["RateLimit-Policy"]).toBe(
      '"email-unsubscribe-counts";q=60;w=60'
    );
  });
});
