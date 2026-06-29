import {
  __resetRateLimitBuckets,
  checkRateLimit,
  getRequestIp,
} from "@/utils/rate-limit";
import { incrementRateLimitCounter } from "@/utils/db/db-service";

// Keep these unit tests hermetic: the shared (Postgres) store is mocked so we
// exercise the limiter's logic without a live database.
jest.mock("@/utils/db/db-service", () => ({
  incrementRateLimitCounter: jest.fn(),
  cleanupExpiredRateLimitCounters: jest.fn().mockResolvedValue(undefined),
}));

const mockIncrement = incrementRateLimitCounter as jest.MockedFunction<
  typeof incrementRateLimitCounter
>;

// Behavior when the shared store is unavailable: checkRateLimit falls back to
// its per-process in-memory counter. Forcing the increment to throw drives that
// fallback path, which __resetRateLimitBuckets resets between tests.
describe("checkRateLimit (in-memory fallback)", () => {
  beforeEach(() => {
    __resetRateLimitBuckets();
    mockIncrement.mockReset();
    mockIncrement.mockRejectedValue(new Error("shared store unavailable"));
  });

  it("allows requests below the limit and denies once exceeded", async () => {
    const opts = { limit: 3, windowMs: 60_000 };
    expect((await checkRateLimit("bucket", "ip-a", opts)).ok).toBe(true);
    expect((await checkRateLimit("bucket", "ip-a", opts)).ok).toBe(true);
    expect((await checkRateLimit("bucket", "ip-a", opts)).ok).toBe(true);
    const denied = await checkRateLimit("bucket", "ip-a", opts);
    expect(denied.ok).toBe(false);
    expect(denied.remaining).toBe(0);
  });

  it("tracks separate keys independently", async () => {
    const opts = { limit: 1, windowMs: 60_000 };
    expect((await checkRateLimit("bucket", "ip-a", opts)).ok).toBe(true);
    expect((await checkRateLimit("bucket", "ip-b", opts)).ok).toBe(true);
    expect((await checkRateLimit("bucket", "ip-a", opts)).ok).toBe(false);
    expect((await checkRateLimit("bucket", "ip-b", opts)).ok).toBe(false);
  });

  it("tracks separate buckets independently", async () => {
    const opts = { limit: 1, windowMs: 60_000 };
    expect((await checkRateLimit("bucket-x", "ip-a", opts)).ok).toBe(true);
    expect((await checkRateLimit("bucket-y", "ip-a", opts)).ok).toBe(true);
    expect((await checkRateLimit("bucket-x", "ip-a", opts)).ok).toBe(false);
  });

  it("resets after the window elapses", async () => {
    const realNow = Date.now;
    let current = 1_000_000;
    Date.now = () => current;
    try {
      const opts = { limit: 1, windowMs: 1_000 };
      expect((await checkRateLimit("bucket", "ip-a", opts)).ok).toBe(true);
      expect((await checkRateLimit("bucket", "ip-a", opts)).ok).toBe(false);
      current += 1_500;
      expect((await checkRateLimit("bucket", "ip-a", opts)).ok).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });
});

// Behavior backed by the shared store: the decision is derived from the count
// the store returns, so the ceiling is enforced consistently across instances.
describe("checkRateLimit (shared store)", () => {
  beforeEach(() => {
    __resetRateLimitBuckets();
    mockIncrement.mockReset();
  });

  it("allows while the shared count stays within the limit", async () => {
    mockIncrement.mockResolvedValue({ count: 1, resetAt: 9_999 });
    const result = await checkRateLimit("bucket", "ip-a", {
      limit: 5,
      windowMs: 60_000,
    });
    expect(result.ok).toBe(true);
    expect(result.remaining).toBe(4);
    expect(result.resetAt).toBe(9_999);
  });

  it("denies once the shared count exceeds the limit", async () => {
    mockIncrement.mockResolvedValue({ count: 6, resetAt: 9_999 });
    const result = await checkRateLimit("bucket", "ip-a", {
      limit: 5,
      windowMs: 60_000,
    });
    expect(result.ok).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("short-circuits a blocked key without another DB round-trip until the window resets", async () => {
    const realNow = Date.now;
    let current = 1_000_000;
    Date.now = () => current;
    try {
      const opts = { limit: 5, windowMs: 60_000 };
      // First over-limit verdict comes from the shared store and is cached.
      mockIncrement.mockResolvedValue({ count: 6, resetAt: current + 60_000 });
      const first = await checkRateLimit("agent-view", "ip-a", opts);
      expect(first.ok).toBe(false);
      expect(mockIncrement).toHaveBeenCalledTimes(1);

      // Subsequent requests in the same window are rejected locally, with no
      // further calls to the shared store.
      const second = await checkRateLimit("agent-view", "ip-a", opts);
      expect(second.ok).toBe(false);
      expect(second.remaining).toBe(0);
      expect(second.resetAt).toBe(1_000_000 + 60_000);
      expect(mockIncrement).toHaveBeenCalledTimes(1);

      // Once the window resets, the next request re-checks the shared store.
      current += 60_001;
      mockIncrement.mockResolvedValue({ count: 1, resetAt: current + 60_000 });
      const third = await checkRateLimit("agent-view", "ip-a", opts);
      expect(third.ok).toBe(true);
      expect(mockIncrement).toHaveBeenCalledTimes(2);
    } finally {
      Date.now = realNow;
    }
  });

  it("only short-circuits the blocked key, leaving other keys to the shared store", async () => {
    const opts = { limit: 5, windowMs: 60_000 };
    const resetAt = Date.now() + 60_000;

    // ip-a goes over the limit and gets a cached local block.
    mockIncrement.mockResolvedValueOnce({ count: 6, resetAt });
    expect((await checkRateLimit("bucket", "ip-a", opts)).ok).toBe(false);
    expect(mockIncrement).toHaveBeenCalledTimes(1);

    // A second blocked request for ip-a is shed without touching the store...
    expect((await checkRateLimit("bucket", "ip-a", opts)).ok).toBe(false);
    expect(mockIncrement).toHaveBeenCalledTimes(1);

    // ...but a different key still goes through to the shared store.
    mockIncrement.mockResolvedValueOnce({ count: 1, resetAt });
    expect((await checkRateLimit("bucket", "ip-b", opts)).ok).toBe(true);
    expect(mockIncrement).toHaveBeenCalledTimes(2);
  });

  it("passes the bucket, key and window through to the shared store", async () => {
    mockIncrement.mockResolvedValue({ count: 1, resetAt: 9_999 });
    await checkRateLimit("agent-view", "5.6.7.8", {
      limit: 600,
      windowMs: 60_000,
    });
    expect(mockIncrement).toHaveBeenCalledWith(
      "agent-view",
      "5.6.7.8",
      60_000,
      expect.any(Number)
    );
  });
});

describe("getRequestIp", () => {
  const originalTrustProxyHeaders = process.env.TRUST_PROXY_HEADERS;
  const originalTrustedProxyIps = process.env.TRUSTED_PROXY_IPS;

  beforeEach(() => {
    delete process.env.TRUST_PROXY_HEADERS;
    delete process.env.TRUSTED_PROXY_IPS;
  });

  afterEach(() => {
    if (originalTrustProxyHeaders === undefined) {
      delete process.env.TRUST_PROXY_HEADERS;
    } else {
      process.env.TRUST_PROXY_HEADERS = originalTrustProxyHeaders;
    }

    if (originalTrustedProxyIps === undefined) {
      delete process.env.TRUSTED_PROXY_IPS;
    } else {
      process.env.TRUSTED_PROXY_IPS = originalTrustedProxyIps;
    }
  });

  it("ignores x-forwarded-for unless proxy headers are trusted", () => {
    const req = {
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
      socket: { remoteAddress: "9.9.9.9" },
    } as any;
    expect(getRequestIp(req)).toBe("9.9.9.9");
  });

  it("uses the rightmost entry in x-forwarded-for when proxy headers are trusted", () => {
    process.env.TRUST_PROXY_HEADERS = "true";
    const req = {
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
      socket: { remoteAddress: "9.9.9.9" },
    } as any;
    expect(getRequestIp(req)).toBe("5.6.7.8");
  });

  it("uses the rightmost entry across repeated x-forwarded-for headers", () => {
    process.env.TRUST_PROXY_HEADERS = "true";
    const req = {
      headers: { "x-forwarded-for": ["1.2.3.4", "5.6.7.8, 6.7.8.9"] },
      socket: { remoteAddress: "9.9.9.9" },
    } as any;
    expect(getRequestIp(req)).toBe("6.7.8.9");
  });

  it("trusts x-forwarded-for when the direct peer is a trusted proxy", () => {
    process.env.TRUSTED_PROXY_IPS = "9.9.9.9";
    const req = {
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
      socket: { remoteAddress: "9.9.9.9" },
    } as any;
    expect(getRequestIp(req)).toBe("5.6.7.8");
  });

  it("ignores x-real-ip and falls back to the socket remote address", () => {
    const req = {
      headers: { "x-real-ip": "4.3.2.1" },
      socket: { remoteAddress: "9.9.9.9" },
    } as any;
    expect(getRequestIp(req)).toBe("9.9.9.9");
  });

  it("falls back to the socket remote address", () => {
    const req = {
      headers: {},
      socket: { remoteAddress: "9.9.9.9" },
    } as any;
    expect(getRequestIp(req)).toBe("9.9.9.9");
  });

  it("normalizes IPv6-mapped IPv4 socket addresses", () => {
    const req = {
      headers: {},
      socket: { remoteAddress: "::ffff:9.9.9.9" },
    } as any;
    expect(getRequestIp(req)).toBe("9.9.9.9");
  });

  it("normalizes IPv6-mapped IPv4 forwarded addresses", () => {
    process.env.TRUST_PROXY_HEADERS = "true";
    const req = {
      headers: { "x-forwarded-for": "1.2.3.4, ::ffff:5.6.7.8" },
      socket: { remoteAddress: "9.9.9.9" },
    } as any;
    expect(getRequestIp(req)).toBe("5.6.7.8");
  });

  it("returns 'unknown' when nothing is available", () => {
    const req = { headers: {}, socket: {} } as any;
    expect(getRequestIp(req)).toBe("unknown");
  });
});
