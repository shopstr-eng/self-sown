/** @jest-environment node */

/**
 * Two gaps the proxy's advisory `RateLimit-Policy: "agent";q=600;w=60` hid:
 *
 * 1. The account-recovery routes (pages/api/auth/*) limit via
 *    utils/auth/rate-limit.ts, which set no RateLimit headers at all — so a
 *    5-per-15-minute recovery budget advertised itself as 600/minute. This
 *    pins the policy on both allowed and 429 responses.
 *
 * 2. /api/storefront/preview-from-url checks a tight per-IP budget (3/60s)
 *    and then, on cache miss, a global LLM-spend cap (40/60s). The global
 *    check overwrote the per-IP policy on success, concealing the limit that
 *    actually rejects the caller's fourth request. This pins the per-IP
 *    policy on success and the global policy only on a global-bucket 429.
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

jest.mock("@/utils/migrations/site-design-extractor", () => ({
  extractSiteSignals: jest.fn(() => Promise.resolve({ title: "Fake Farm" })),
  hasUsableSignals: jest.fn(() => true),
  SiteExtractionError: class SiteExtractionError extends Error {},
}));

jest.mock("@/utils/migrations/site-design", () => ({
  buildExtractionDraft: jest.fn(() => ({ warnings: [], theme: {} })),
  buildProductPageDraft: jest.fn(() => ({ warnings: [] })),
}));

jest.mock("@/utils/storefront/ai-compose", () => ({
  composeStoreDesignWithAI: jest.fn(() => Promise.resolve(null)),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import { rateLimit } from "@/utils/auth/rate-limit";
import { __resetRateLimitBuckets } from "@/utils/rate-limit";
import previewHandler from "@/pages/api/storefront/preview-from-url";

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

describe("account-recovery rate limiter policy header", () => {
  // Unique bucket names per test: the limiter's stores are module-level.
  it("advertises the enforced limit/window on allowed requests", async () => {
    const limiter = rateLimit({
      name: "recovery-test-allowed",
      windowMs: 15 * 60 * 1000,
      maxRequests: 5,
    });
    const res = fakeRes();

    expect(await limiter(fakeReq(), res)).toBe(true);
    expect(res.headers["RateLimit-Policy"]).toBe(
      '"recovery-test-allowed";q=5;w=900'
    );
    expect(res.headers["RateLimit-Limit"]).toBe("5");
    expect(res.headers["RateLimit-Remaining"]).toBe("4");
  });

  it("still advertises the real policy on the 429 response", async () => {
    const limiter = rateLimit({
      name: "recovery-test-denied",
      windowMs: 15 * 60 * 1000,
      maxRequests: 2,
    });
    expect(await limiter(fakeReq(), fakeRes())).toBe(true);
    expect(await limiter(fakeReq(), fakeRes())).toBe(true);

    const res = fakeRes();
    expect(await limiter(fakeReq(), res)).toBe(false);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.headers["RateLimit-Policy"]).toBe(
      '"recovery-test-denied";q=2;w=900'
    );
    expect(res.headers["Retry-After"]).toBeDefined();
  });
});

describe("preview-from-url dual-bucket policy", () => {
  beforeEach(() => {
    __resetRateLimitBuckets();
  });

  it("keeps the tighter per-IP policy on a successful cache miss", async () => {
    const res = fakeRes();
    await previewHandler(
      fakeReq({
        method: "POST",
        body: { url: "https://per-ip-policy.example.com" },
      }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.headers["RateLimit-Policy"]).toBe('"storefront-preview";q=3;w=60');
  });

  it("advertises the global policy only when the global bucket rejects", async () => {
    // Burn the 40/60s global bucket from 40 distinct IPs (per-IP limit is
    // 3/60s each, so one IP can't do this) with distinct URLs (cache hits
    // don't consume the global budget).
    for (let i = 0; i < 40; i++) {
      const res = fakeRes();
      await previewHandler(
        fakeReq({
          method: "POST",
          socket: { remoteAddress: `203.0.113.${i + 1}` },
          body: { url: `https://global-burn-${i}.example.com` },
        }),
        res
      );
      expect(res.status).toHaveBeenCalledWith(200);
    }

    const res = fakeRes();
    await previewHandler(
      fakeReq({
        method: "POST",
        socket: { remoteAddress: "198.51.100.7" },
        body: { url: "https://global-burn-overflow.example.com" },
      }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.headers["RateLimit-Policy"]).toBe(
      '"storefront-preview-global";q=40;w=60'
    );
  });
});
