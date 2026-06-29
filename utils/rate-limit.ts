import type { NextApiRequest, NextApiResponse } from "next";
import {
  cleanupExpiredRateLimitCounters,
  incrementRateLimitCounter,
} from "@/utils/db/db-service";

export type RateLimitResult = {
  ok: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
};

export type RateLimitOptions = {
  limit: number;
  windowMs: number;
};

// In-process fallback store. Used only when the shared (Postgres) store is
// unavailable — e.g. DATABASE_URL is unset (unit tests) or a transient DB
// error. The shared store is the source of truth in production so the ceiling
// stays predictable across horizontally-scaled instances; this map is a
// degraded, per-process safety net so an outage never blocks a request.
const buckets = new Map<
  string,
  Map<string, { count: number; resetAt: number }>
>();

// Probability of opportunistically pruning expired shared rows on a given
// allowed request, keeping the table bounded by active clients without adding
// a delete to every request.
const CLEANUP_PROBABILITY = 0.01;

// Per-process cache of keys the shared store has already reported as over their
// limit, mapped to the window reset time the store returned. While a key is in
// here and its window hasn't reset, checkRateLimit rejects it WITHOUT a DB
// round-trip. This sheds the per-request Postgres load exactly where it is
// heaviest — an abusive/over-limit client (e.g. a crawler hammering agent-view
// and collecting 429s) — instead of issuing an upsert for every one of those
// doomed requests. It never weakens the cross-instance ceiling: we only ever
// cache the store's "blocked" verdict (never an "allowed" one), so a request is
// only ever rejected earlier, never permitted beyond the shared count. Cleared
// for a key the moment the store next reports it under the limit.
const blockedUntil = new Map<string, Map<string, number>>();

// Probability of sweeping the whole blocked-cache for expired entries on a
// given request, so keys that go permanently silent after being blocked don't
// leak. Expired entries are also dropped on access, so this only mops up the
// never-seen-again tail.
const BLOCKED_SWEEP_PROBABILITY = 0.01;

function getBlockedResetAt(
  bucketName: string,
  key: string,
  now: number
): number | undefined {
  const bucket = blockedUntil.get(bucketName);
  if (!bucket) return undefined;
  const resetAt = bucket.get(key);
  if (resetAt === undefined) return undefined;
  if (now >= resetAt) {
    // Window has rolled over; drop the stale block so the next request
    // re-checks the shared store.
    bucket.delete(key);
    if (bucket.size === 0) blockedUntil.delete(bucketName);
    return undefined;
  }
  return resetAt;
}

function setBlocked(bucketName: string, key: string, resetAt: number): void {
  let bucket = blockedUntil.get(bucketName);
  if (!bucket) {
    bucket = new Map();
    blockedUntil.set(bucketName, bucket);
  }
  bucket.set(key, resetAt);
}

function clearBlocked(bucketName: string, key: string): void {
  const bucket = blockedUntil.get(bucketName);
  if (!bucket) return;
  if (bucket.delete(key) && bucket.size === 0) {
    blockedUntil.delete(bucketName);
  }
}

function sweepExpiredBlocked(now: number): void {
  for (const [bucketName, bucket] of blockedUntil) {
    for (const [key, resetAt] of bucket) {
      if (now >= resetAt) bucket.delete(key);
    }
    if (bucket.size === 0) blockedUntil.delete(bucketName);
  }
}

function normalizeIp(ip: string | undefined): string | undefined {
  const trimmed = ip?.trim();
  if (!trimmed) return undefined;

  return trimmed.startsWith("::ffff:")
    ? trimmed.slice("::ffff:".length)
    : trimmed;
}

function isTruthyEnv(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.toLowerCase() ?? "");
}

function getTrustedProxyIps(): Set<string> {
  return new Set(
    (process.env.TRUSTED_PROXY_IPS ?? "")
      .split(",")
      .map((ip) => normalizeIp(ip))
      .filter((ip): ip is string => !!ip)
  );
}

function shouldTrustForwardedFor(remoteAddress: string | undefined): boolean {
  if (isTruthyEnv(process.env.TRUST_PROXY_HEADERS)) return true;

  const normalizedRemoteAddress = normalizeIp(remoteAddress);
  if (!normalizedRemoteAddress) return false;

  return getTrustedProxyIps().has(normalizedRemoteAddress);
}

function getForwardedForIp(
  forwarded: string | string[] | undefined
): string | undefined {
  const forwardedValues = Array.isArray(forwarded)
    ? forwarded
    : forwarded
      ? [forwarded]
      : [];

  for (let i = forwardedValues.length - 1; i >= 0; i--) {
    const forwardedValue = forwardedValues[i];
    if (!forwardedValue) continue;

    const forwardedParts = forwardedValue
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    const rightmostForwarded = forwardedParts[forwardedParts.length - 1];
    const normalizedForwarded = normalizeIp(rightmostForwarded);
    if (normalizedForwarded) return normalizedForwarded;
  }

  return undefined;
}

function getBucket(
  name: string
): Map<string, { count: number; resetAt: number }> {
  let bucket = buckets.get(name);
  if (!bucket) {
    bucket = new Map();
    buckets.set(name, bucket);
  }
  return bucket;
}

// Per-process counting used when the shared store is unavailable.
function checkRateLimitInMemory(
  bucketName: string,
  key: string,
  options: RateLimitOptions
): RateLimitResult {
  const now = Date.now();
  const bucket = getBucket(bucketName);
  const entry = bucket.get(key);

  if (!entry || now > entry.resetAt) {
    const resetAt = now + options.windowMs;
    bucket.set(key, { count: 1, resetAt });
    return {
      ok: true,
      limit: options.limit,
      remaining: options.limit - 1,
      resetAt,
    };
  }

  if (entry.count >= options.limit) {
    return {
      ok: false,
      limit: options.limit,
      remaining: 0,
      resetAt: entry.resetAt,
    };
  }

  entry.count++;
  return {
    ok: true,
    limit: options.limit,
    remaining: options.limit - entry.count,
    resetAt: entry.resetAt,
  };
}

/**
 * Check (and consume) one unit of the rate-limit budget for `key` within
 * `bucketName`. Counters live in a shared Postgres store so the ceiling is
 * enforced consistently across all running instances. If the shared store is
 * unavailable (DATABASE_URL unset in unit tests, or a transient DB error) this
 * transparently falls back to a per-process in-memory counter so the limiter
 * degrades gracefully and never blocks a request because the store is down.
 */
export async function checkRateLimit(
  bucketName: string,
  key: string,
  options: RateLimitOptions
): Promise<RateLimitResult> {
  const now = Date.now();

  // Fast path: if the shared store already told us this key is over its limit
  // for the current window, reject it here without a DB round-trip. This can
  // only reject earlier than the shared count would, never permit beyond it, so
  // the cross-instance ceiling is preserved.
  const blockedResetAt = getBlockedResetAt(bucketName, key, now);
  if (blockedResetAt !== undefined) {
    return {
      ok: false,
      limit: options.limit,
      remaining: 0,
      resetAt: blockedResetAt,
    };
  }

  try {
    const { count, resetAt } = await incrementRateLimitCounter(
      bucketName,
      key,
      options.windowMs,
      now
    );
    const ok = count <= options.limit;
    if (ok) {
      clearBlocked(bucketName, key);
      if (Math.random() < CLEANUP_PROBABILITY) {
        void cleanupExpiredRateLimitCounters(now);
      }
    } else {
      // Remember the block so the rest of this client's window is shed off the
      // DB hot path.
      setBlocked(bucketName, key, resetAt);
      if (Math.random() < BLOCKED_SWEEP_PROBABILITY) {
        sweepExpiredBlocked(now);
      }
    }
    return {
      ok,
      limit: options.limit,
      remaining: Math.max(0, options.limit - count),
      resetAt,
    };
  } catch {
    // Shared store unavailable — fall back to the per-process counter.
    return checkRateLimitInMemory(bucketName, key, options);
  }
}

export function getRequestIp(req: NextApiRequest): string {
  const remoteAddress = normalizeIp(req.socket?.remoteAddress);

  if (shouldTrustForwardedFor(remoteAddress)) {
    const forwardedIp = getForwardedForIp(req.headers["x-forwarded-for"]);
    if (forwardedIp) return forwardedIp;

    const realIp = req.headers["x-real-ip"];
    const realIpValue = Array.isArray(realIp) ? realIp[0] : realIp;
    const normalizedRealIp = normalizeIp(realIpValue);
    if (normalizedRealIp) return normalizedRealIp;
  }

  return remoteAddress ?? "unknown";
}

/**
 * Convenience wrapper for the common "check rate limit, set Retry-After,
 * respond 429" pattern used in API route handlers. Returns `true` when the
 * caller should continue handling the request, or `false` when a 429 has
 * already been written and the handler should `return` immediately.
 *
 * NOTE: Counters live in a shared Postgres store (see `checkRateLimit`), so the
 * effective ceiling is `limit` regardless of how many instances are running.
 * If the shared store is unavailable the limiter degrades to a per-process
 * in-memory counter (effectively `N × limit`) rather than failing the request.
 */
export function setRateLimitHeaders(
  res: NextApiResponse,
  rate: RateLimitResult
): void {
  const resetSeconds = Math.max(
    0,
    Math.ceil((rate.resetAt - Date.now()) / 1000)
  );
  // IETF draft "RateLimit Fields for HTTP" header set, plus the widely-used
  // X-RateLimit-* aliases so older agent clients also see the budget.
  res.setHeader("RateLimit-Limit", String(rate.limit));
  res.setHeader("RateLimit-Remaining", String(Math.max(0, rate.remaining)));
  res.setHeader("RateLimit-Reset", String(resetSeconds));
  res.setHeader("X-RateLimit-Limit", String(rate.limit));
  res.setHeader("X-RateLimit-Remaining", String(Math.max(0, rate.remaining)));
  res.setHeader("X-RateLimit-Reset", String(Math.floor(rate.resetAt / 1000)));
}

export async function applyRateLimit(
  req: NextApiRequest,
  res: NextApiResponse,
  bucketName: string,
  options: RateLimitOptions,
  key?: string
): Promise<boolean> {
  const rate = await checkRateLimit(
    bucketName,
    key ?? getRequestIp(req),
    options
  );
  setRateLimitHeaders(res, rate);
  if (!rate.ok) {
    res.setHeader(
      "Retry-After",
      Math.max(1, Math.ceil((rate.resetAt - Date.now()) / 1000))
    );
    res.status(429).json({
      error: "Too many requests",
      code: "rate_limited",
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((rate.resetAt - Date.now()) / 1000)
      ),
    });
    return false;
  }
  return true;
}

// Exported for tests only.
export function __resetRateLimitBuckets(): void {
  buckets.clear();
  blockedUntil.clear();
}
