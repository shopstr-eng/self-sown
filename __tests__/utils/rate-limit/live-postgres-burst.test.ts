/** @jest-environment node */

/**
 * LIVE load verification for the shared rate limiter (#145): drives bursts of
 * concurrent checkRateLimit calls from under-limit and over-limit clients
 * against a REAL Postgres-backed store (not a mocked one), confirming:
 *
 *  1. An over-limit client is shed onto the per-process blocked cache after
 *     its first block verdict — DB round-trips stop growing while its
 *     requests keep coming. Round-trips are measured via the shared counter
 *     itself: one upsert increments the count by exactly one within a window,
 *     so a frozen count under continued requests proves local shedding.
 *  2. Under-limit traffic during the same spike stays healthy: every request
 *     allowed, bounded p95 check latency AND bounded pool-acquisition p95
 *     (the shared pool is max=10; the under-limit test deliberately runs 12
 *     concurrent keys to force connection queuing), and no fail-open fallback
 *     (final DB counts exactly match the number of requests sent — a fallback
 *     to the in-memory store would leave the shared count short).
 *  3. The atomic upsert keeps exact counts under concurrent same-key load.
 *
 * GATED: runs ONLY when RATE_LIMIT_TEST_DATABASE_URL is explicitly set (its
 * value overrides DATABASE_URL for this process). There is intentionally no
 * RUN_TESTCONTAINERS branch — this suite provisions no container, so that
 * flag would silently run against whatever ambient DATABASE_URL is present.
 * Uses unique per-run zz-loadtest-<ts>-* buckets and deletes only this run's
 * buckets afterwards (plus stragglers older than 2h from crashed runs), so
 * concurrent runs can't delete each other's rows; never touches real
 * counters. A 10-minute window makes mid-run rollover effectively impossible.
 */

const RUN = !!process.env.RATE_LIMIT_TEST_DATABASE_URL;
// The pool is built lazily on first use, so overriding DATABASE_URL here —
// before any test runs — is enough.
if (RUN) {
  process.env.DATABASE_URL = process.env.RATE_LIMIT_TEST_DATABASE_URL;
}

import {
  checkRateLimit,
  __resetRateLimitBuckets,
} from "@/utils/rate-limit";
import * as dbService from "@/utils/db/db-service";

const RUN_ID = `zz-loadtest-${Date.now()}`;
const WINDOW_MS = 600_000; // 10 min — no mid-run rollover
// Remote-Neon-friendly ceilings: the point is "no material degradation / no
// pool exhaustion", not a tight latency SLO.
const P95_BUDGET_MS = 2000;
const P95_ACQUIRE_BUDGET_MS = 1500;
const STRAGGLER_AGE_MS = 2 * 60 * 60 * 1000;

const describeLive = RUN ? describe : describe.skip;

function p95(sorted: number[]): number {
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0
  );
}

describeLive("rate limiter under burst load (LIVE Postgres)", () => {
  jest.setTimeout(240_000);

  // Instrument real pool-acquisition latency by wrapping the pool instance's
  // connect (an own-property assignment — the module's export surface is
  // non-configurable under jest interop, but the pool object is not).
  const acquireMs: number[] = [];
  let origConnect: (() => Promise<any>) | undefined;

  beforeAll(() => {
    const pool = dbService.getDbPool();
    origConnect = pool.connect.bind(pool);
    (pool as any).connect = async () => {
      const t0 = performance.now();
      const client = await origConnect!();
      acquireMs.push(performance.now() - t0);
      return client;
    };
  });

  afterAll(async () => {
    const pool = dbService.getDbPool();
    if (origConnect) (pool as any).connect = origConnect;
    const client = await pool.connect();
    try {
      // This run's rows (exact prefix) + stragglers from crashed runs older
      // than 2h — never rows another in-flight run could own.
      await client.query(
        `DELETE FROM rate_limit_counters WHERE bucket LIKE $1`,
        [`${RUN_ID}-%`]
      );
      await client.query(
        `DELETE FROM rate_limit_counters
          WHERE bucket LIKE 'zz-loadtest-%' AND window_start < $1`,
        [Date.now() - STRAGGLER_AGE_MS]
      );
    } finally {
      client.release();
    }
    await pool.end();
  });

  beforeEach(() => {
    __resetRateLimitBuckets();
    acquireMs.length = 0;
  });

  async function dbCount(bucket: string, key: string): Promise<number | null> {
    const client = await dbService.getDbPool().connect();
    try {
      const res = await client.query(
        `SELECT count FROM rate_limit_counters WHERE bucket = $1 AND rate_key = $2`,
        [bucket, key]
      );
      return res.rows[0] ? Number(res.rows[0].count) : null;
    } finally {
      client.release();
    }
  }

  it("sheds an over-limit client off the DB after the first block verdict", async () => {
    const bucket = `${RUN_ID}-shed`;
    const key = "abusive-client";
    const limit = 5;

    // Requests 1-5 allowed; request 6 hits the DB and gets the block verdict.
    const first: boolean[] = [];
    for (let i = 0; i < 6; i++) {
      first.push(
        (await checkRateLimit(bucket, key, { limit, windowMs: WINDOW_MS })).ok
      );
    }
    // Explicit allowed -> blocked transition at the limit boundary.
    expect(first).toEqual([true, true, true, true, true, false]);
    expect(await dbCount(bucket, key)).toBe(6);

    // The rest of the window is rejected locally: the shared count must NOT
    // grow (each DB round-trip would increment it).
    for (let i = 0; i < 44; i++) {
      const r = await checkRateLimit(bucket, key, {
        limit,
        windowMs: WINDOW_MS,
      });
      expect(r.ok).toBe(false);
    }
    expect(await dbCount(bucket, key)).toBe(6);
  });

  it("under-limit burst OVER-SUBSCRIBING the pool keeps exact counts and bounded p95", async () => {
    const bucket = `${RUN_ID}-burst`;
    // 12 concurrent keys against a max=10 pool forces connection queuing —
    // this is what makes the pool-wait assertion meaningful.
    const keys = Array.from({ length: 12 }, (_, i) => `normal-${i}`);
    const WAVES = 15;
    const latencies: number[] = [];
    const oks: boolean[] = [];

    for (let w = 0; w < WAVES; w++) {
      await Promise.all(
        keys.map(async (k) => {
          const t0 = performance.now();
          const r = await checkRateLimit(bucket, k, {
            limit: 1000,
            windowMs: WINDOW_MS,
          });
          latencies.push(performance.now() - t0);
          oks.push(r.ok);
        })
      );
    }

    expect(oks.every(Boolean)).toBe(true);
    latencies.sort((a, b) => a - b);
    const sortedAcquire = [...acquireMs].sort((a, b) => a - b);
    const maxMs = latencies[latencies.length - 1] ?? 0;
    console.log(
      `[live-burst] under-limit: ${latencies.length} checks, p95 ${p95(latencies).toFixed(0)}ms, ` +
        `max ${maxMs.toFixed(0)}ms, ` +
        `pool-acquire p95 ${p95(sortedAcquire).toFixed(0)}ms over ${sortedAcquire.length} acquisitions`
    );
    expect(p95(latencies)).toBeLessThan(P95_BUDGET_MS);
    expect(sortedAcquire.length).toBeGreaterThan(0);
    expect(p95(sortedAcquire)).toBeLessThan(P95_ACQUIRE_BUDGET_MS);

    // Each request consumed exactly one shared-store unit — the count match
    // also proves no request silently fell back to the in-memory store.
    for (const k of keys) {
      expect(await dbCount(bucket, k)).toBe(WAVES);
    }
  });

  it("mixed spike: abusive client sheds while normal traffic stays correct", async () => {
    const bucket = `${RUN_ID}-mixed`;
    const abusive = "crawler";
    const normals = ["n1", "n2", "n3", "n4"];
    const normalOks: boolean[] = [];
    const normalLatencies: number[] = [];

    const normalJob = async (k: string) => {
      const t0 = performance.now();
      const r = await checkRateLimit(bucket, k, {
        limit: 1000,
        windowMs: WINDOW_MS,
      });
      normalLatencies.push(performance.now() - t0);
      normalOks.push(r.ok);
    };

    // 100 abusive requests in waves of 10 (a real crawler's requests arrive
    // over time; only the first wave can be in flight before the block is
    // cached), interleaved with 4 normal clients x 20 requests.
    const abusiveWaves = 10;
    for (let w = 0; w < abusiveWaves; w++) {
      const jobs: Promise<void>[] = [];
      for (let i = 0; i < 10; i++) {
        jobs.push(
          checkRateLimit(bucket, abusive, {
            limit: 5,
            windowMs: WINDOW_MS,
          }).then(() => undefined)
        );
      }
      for (const n of normals) {
        for (let i = 0; i < 2; i++) jobs.push(normalJob(n));
      }
      await Promise.all(jobs);
    }

    // Normal traffic: everything allowed, p95 bounded even mid-spike.
    expect(normalOks.every(Boolean)).toBe(true);
    normalLatencies.sort((a, b) => a - b);
    const abusiveCount = await dbCount(bucket, abusive);
    console.log(
      `[live-burst] mixed: abusive hit DB ${abusiveCount}/100 times; normal p95 ${p95(normalLatencies).toFixed(0)}ms`
    );
    expect(p95(normalLatencies)).toBeLessThan(P95_BUDGET_MS);

    // The abusive client's DB round-trips are bounded by its first wave
    // (10 in flight) — not its 100 requests — and stop growing once blocked.
    expect(abusiveCount).not.toBeNull();
    expect(abusiveCount!).toBeGreaterThanOrEqual(6);
    expect(abusiveCount!).toBeLessThanOrEqual(15);
    for (let i = 0; i < 20; i++) {
      const r = await checkRateLimit(bucket, abusive, {
        limit: 5,
        windowMs: WINDOW_MS,
      });
      expect(r.ok).toBe(false);
    }
    expect(await dbCount(bucket, abusive)).toBe(abusiveCount);

    // Same-key atomicity held for normal clients despite the concurrent spike.
    for (const n of normals) {
      expect(await dbCount(bucket, n)).toBe(20);
    }
  });
});
