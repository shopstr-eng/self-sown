import type { NextApiRequest, NextApiResponse } from "next";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const stores = new Map<string, Map<string, RateLimitEntry>>();

function getStore(name: string): Map<string, RateLimitEntry> {
  if (!stores.has(name)) {
    stores.set(name, new Map());
  }
  return stores.get(name)!;
}

export interface RateLimitConfig {
  name: string;
  windowMs: number;
  maxRequests: number;
  keyFn?: (req: NextApiRequest) => string;
}

export function rateLimit(config: RateLimitConfig) {
  const { name, windowMs, maxRequests, keyFn } = config;

  // The proxy stamps a generic advisory RateLimit-Policy (q=600;w=60) on every
  // response; overwrite it with the budget this limiter actually enforces on
  // both allowed and rejected requests, or agents scheduling around the header
  // are misled.
  const report = (
    res: NextApiResponse,
    remaining: number,
    resetAt: number
  ): void => {
    res.setHeader(
      "RateLimit-Policy",
      `"${name}";q=${maxRequests};w=${Math.round(windowMs / 1000)}`
    );
    res.setHeader("RateLimit-Limit", String(maxRequests));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, remaining)));
    res.setHeader(
      "RateLimit-Reset",
      String(Math.max(0, Math.ceil((resetAt - Date.now()) / 1000)))
    );
    res.setHeader("X-RateLimit-Limit", String(maxRequests));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, remaining)));
    res.setHeader("X-RateLimit-Reset", String(Math.floor(resetAt / 1000)));
  };

  return async function check(
    req: NextApiRequest,
    res: NextApiResponse
  ): Promise<boolean> {
    const store = getStore(name);
    const now = Date.now();

    for (const [key, entry] of store) {
      if (entry.resetAt < now) store.delete(key);
    }

    const identifier = keyFn
      ? keyFn(req)
      : (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
        req.socket.remoteAddress ||
        "unknown";

    const entry = store.get(identifier);

    if (!entry || entry.resetAt < now) {
      const resetAt = now + windowMs;
      store.set(identifier, { count: 1, resetAt });
      report(res, maxRequests - 1, resetAt);
      return true;
    }

    if (entry.count >= maxRequests) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      report(res, 0, entry.resetAt);
      res.setHeader("Retry-After", retryAfter.toString());
      res.status(429).json({
        error: "Too many requests. Please try again later.",
        retryAfterSeconds: retryAfter,
      });
      return false;
    }

    entry.count++;
    report(res, maxRequests - entry.count, entry.resetAt);
    return true;
  };
}

export const recoveryRequestLimiter = rateLimit({
  name: "recovery-request",
  windowMs: 15 * 60 * 1000,
  maxRequests: 5,
});

export const recoveryVerifyLimiter = rateLimit({
  name: "recovery-verify",
  windowMs: 15 * 60 * 1000,
  maxRequests: 10,
});

export const recoveryResetLimiter = rateLimit({
  name: "recovery-reset",
  windowMs: 15 * 60 * 1000,
  maxRequests: 5,
});

export const recoverySetupVerifyLimiter = rateLimit({
  name: "recovery-setup-verify",
  windowMs: 15 * 60 * 1000,
  maxRequests: 5,
});
