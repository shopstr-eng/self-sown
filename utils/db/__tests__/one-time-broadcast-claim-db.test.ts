/**
 * @jest-environment node
 */

// Real-database proof that a retried one-off broadcast can never double-email.
// The mock suite in __tests__/utils/email/one-time-broadcast.test.ts CANNOT
// prove the race — its claim mocks resolve sequentially. Against a real
// Postgres, this suite exercises claimOneTimeBroadcastWithCap (advisory-lock +
// content_key binding + daily cap) and the content-keyed recipient ledger:
//
//   1. N concurrent claims for the SAME (pubkey, claim_key) with identical
//      content: exactly ONE "claimed", every other caller gets "exists" —
//      one row in one_time_broadcast_claims.
//   2. Reusing a claim key with DIFFERENT content is rejected "mismatch"
//      (serially AND concurrently) — one key can never send unlimited
//      distinct broadcasts around the daily cap.
//   3. Cap enforcement: with the cap nearly saturated, concurrent claims for
//      DISTINCT keys produce at most one winner — the advisory lock keeps the
//      count-and-insert atomic so the daily cap can't be blown past.
//   4. Retry after a claimed-but-failed send cannot re-send: the claim row
//      stays (retry gets "exists", no fresh send authorization), and even
//      after the all-failed release path frees the claim, the content-keyed
//      recipient ledger still blocks re-delivery to an already-emailed
//      contact.
//   5. N concurrent per-recipient claims on one (pubkey, content, email):
//      exactly one winner — the ledger's ON CONFLICT DO NOTHING is atomic.
//
// Two ways to run (both skipped by default so the plain suite stays fast):
//
//   RUN_TESTCONTAINERS=1            — spins up postgres:15-alpine via
//                                     Testcontainers (CI with real Docker;
//                                     NOT runnable in the Replit sandbox,
//                                     which cannot bind container ports).
//   BROADCAST_CLAIM_TEST_DATABASE_URL=postgres://...
//                                   — runs against an existing Postgres
//                                     (e.g. the dev database). All test rows
//                                     are namespaced behind one fixed
//                                     synthetic seller pubkey and deleted in
//                                     afterEach/afterAll.

jest.setTimeout(300000);

// Module marker: keeps the type aliases below out of the global script scope.
export {};

type DbServiceModule = typeof import("../db-service");

const RUN_CONTAINERS = process.env.RUN_TESTCONTAINERS === "1";
const EXTERNAL_DATABASE_URL = process.env.BROADCAST_CLAIM_TEST_DATABASE_URL;
const SHOULD_RUN = RUN_CONTAINERS || Boolean(EXTERNAL_DATABASE_URL);

const maybeIt = SHOULD_RUN ? test : test.skip;

// Fixed synthetic seller pubkey: deterministic so an interrupted previous
// run's rows are swept by the cleanup in beforeAll/afterEach/afterAll.
const SELLER_PK = "a".repeat(64);
const KEY_PREFIX = "bcast:";
const DAILY_LIMIT = 10;

let db: DbServiceModule;
let stopDatabase: (() => Promise<void>) | null = null;
let previousDatabaseUrl: string | undefined;
let claimCounter = 0;

function nextClaimKey(tag: string): string {
  claimCounter += 1;
  return `${KEY_PREFIX}test:${tag}:${Date.now()}:${claimCounter}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeAll(async () => {
  if (!SHOULD_RUN) return;

  let databaseUrl: string;
  if (RUN_CONTAINERS) {
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
    const container = await new PostgreSqlContainer("postgres:15-alpine")
      .withDatabase("shopstr")
      .withUsername("shopstr")
      .withPassword("shopstr")
      .start();
    stopDatabase = async () => {
      await container.stop();
    };
    databaseUrl = `postgres://shopstr:shopstr@${container.getHost()}:${container.getMappedPort(
      5432
    )}/shopstr`;
  } else {
    databaseUrl = EXTERNAL_DATABASE_URL!;
  }

  // DATABASE_URL must stay set for the whole suite: getDbPool reads it
  // lazily on first use. Restored in afterAll.
  previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = databaseUrl;

  await jest.isolateModulesAsync(async () => {
    jest.resetModules();
    jest.unmock("pg");
    db = await import("../db-service");
  });

  await waitForTables([
    "one_time_broadcast_claims",
    "one_time_broadcast_recipients",
  ]);
  await cleanupTestRows();
}, 300000);

afterAll(async () => {
  if (!SHOULD_RUN) return;
  try {
    await cleanupTestRows();
    await db.closeDbPool();
  } finally {
    if (stopDatabase) await stopDatabase();
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
  }
}, 120000);

afterEach(async () => {
  if (!SHOULD_RUN) return;
  await cleanupTestRows();
});

async function waitForTables(tableNames: string[]): Promise<void> {
  const deadline = Date.now() + 60000;
  const pool = db.getDbPool();

  while (Date.now() < deadline) {
    const client = await pool.connect();
    try {
      const result = await client.query<{ tablename: string }>(
        `SELECT tablename
         FROM pg_tables
         WHERE schemaname = 'public'
           AND tablename = ANY($1::text[])`,
        [tableNames]
      );
      if (result.rows.length === tableNames.length) return;
    } finally {
      client.release();
    }
    await sleep(100);
  }

  throw new Error(`Timed out waiting for tables: ${tableNames.join(", ")}`);
}

/** Deletes every row the synthetic seller could have touched. */
async function cleanupTestRows(): Promise<void> {
  const pool = db.getDbPool();
  await pool.query(
    `DELETE FROM one_time_broadcast_claims WHERE pubkey = $1`,
    [SELLER_PK]
  );
  await pool.query(
    `DELETE FROM one_time_broadcast_recipients WHERE pubkey = $1`,
    [SELLER_PK]
  );
}

async function countClaims(): Promise<number> {
  const pool = db.getDbPool();
  const result = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM one_time_broadcast_claims
     WHERE pubkey = $1`,
    [SELLER_PK]
  );
  return Number(result.rows[0]?.n || 0);
}

maybeIt(
  "N concurrent claims on one (pubkey, claim_key): exactly one winner",
  async () => {
    const claimKey = nextClaimKey("same-key");
    const contentKey = "content-aaa";

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        db.claimOneTimeBroadcastWithCap(
          SELLER_PK,
          claimKey,
          contentKey,
          DAILY_LIMIT,
          KEY_PREFIX
        )
      )
    );

    expect(results.filter((r) => r === "claimed")).toHaveLength(1);
    expect(results.filter((r) => r === "exists")).toHaveLength(19);
    expect(results.every((r) => r !== null)).toBe(true);
    expect(await countClaims()).toBe(1);
  }
);

maybeIt(
  "reusing a claim key with DIFFERENT content is rejected as mismatch, serially and concurrently",
  async () => {
    const claimKey = nextClaimKey("mismatch");

    const first = await db.claimOneTimeBroadcastWithCap(
      SELLER_PK,
      claimKey,
      "content-original",
      DAILY_LIMIT,
      KEY_PREFIX
    );
    expect(first).toBe("claimed");

    // Serial reuse with different content: rejected, row unchanged.
    const serialRetry = await db.claimOneTimeBroadcastWithCap(
      SELLER_PK,
      claimKey,
      "content-different",
      DAILY_LIMIT,
      KEY_PREFIX
    );
    expect(serialRetry).toBe("mismatch");

    // Concurrent reuse: the SAME content retries resume ("exists") while
    // DIFFERENT content is rejected ("mismatch") — no outcome flips.
    const mixed = await Promise.all([
      ...Array.from({ length: 5 }, () =>
        db.claimOneTimeBroadcastWithCap(
          SELLER_PK,
          claimKey,
          "content-original",
          DAILY_LIMIT,
          KEY_PREFIX
        )
      ),
      ...Array.from({ length: 5 }, () =>
        db.claimOneTimeBroadcastWithCap(
          SELLER_PK,
          claimKey,
          "content-different",
          DAILY_LIMIT,
          KEY_PREFIX
        )
      ),
    ]);
    expect(mixed.filter((r) => r === "exists")).toHaveLength(5);
    expect(mixed.filter((r) => r === "mismatch")).toHaveLength(5);
    expect(mixed.filter((r) => r === "claimed")).toHaveLength(0);

    // Still exactly one claim row, still bound to the original content.
    expect(await countClaims()).toBe(1);
    const row = await db.getDbPool().query<{ content_key: string | null }>(
      `SELECT content_key FROM one_time_broadcast_claims
       WHERE pubkey = $1 AND claim_key = $2`,
      [SELLER_PK, claimKey]
    );
    expect(row.rows[0]?.content_key).toBe("content-original");
  }
);

maybeIt(
  "concurrent distinct-key claims at the cap boundary cannot exceed the daily cap",
  async () => {
    // Saturate the cap minus one slot with distinct keys.
    for (let i = 0; i < DAILY_LIMIT - 1; i++) {
      const outcome = await db.claimOneTimeBroadcastWithCap(
        SELLER_PK,
        nextClaimKey(`pre-${i}`),
        `content-pre-${i}`,
        DAILY_LIMIT,
        KEY_PREFIX
      );
      expect(outcome).toBe("claimed");
    }

    // Now race many distinct-key claims for the final slot. Without the
    // advisory lock, several could observe a below-cap count and all insert.
    const racers = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        db.claimOneTimeBroadcastWithCap(
          SELLER_PK,
          nextClaimKey(`racer-${i}`),
          `content-racer-${i}`,
          DAILY_LIMIT,
          KEY_PREFIX
        )
      )
    );

    expect(racers.filter((r) => r === "claimed")).toHaveLength(1);
    expect(racers.filter((r) => r === "limit")).toHaveLength(11);
    expect(await countClaims()).toBe(DAILY_LIMIT);

    // Retrying one of the limited-out keys later still hits the cap — a
    // retry must never mint a fresh claim past the limit.
    const retry = await db.claimOneTimeBroadcastWithCap(
      SELLER_PK,
      nextClaimKey("post-cap"),
      "content-post-cap",
      DAILY_LIMIT,
      KEY_PREFIX
    );
    expect(retry).toBe("limit");
    expect(await countClaims()).toBe(DAILY_LIMIT);
  }
);

maybeIt(
  "a retry after a claimed-but-failed send can never re-send to an emailed recipient",
  async () => {
    const claimKey = nextClaimKey("retry");
    const contentKey = "content-retry";
    const emailed = "buyer-one@example.com";
    const unsent = "buyer-two@example.com";

    // First attempt: claim the broadcast, then deliver to one recipient.
    const claim1 = await db.claimOneTimeBroadcastWithCap(
      SELLER_PK,
      claimKey,
      contentKey,
      DAILY_LIMIT,
      KEY_PREFIX
    );
    expect(claim1).toBe("claimed");

    const delivered = await db.claimOneTimeBroadcastRecipient(
      SELLER_PK,
      contentKey,
      emailed
    );
    expect(delivered).toBe(true); // owns delivery → "sent"

    // Simulate a claimed-but-FAILED overall send (e.g. provider outage after
    // one delivery): the all-failed path releases the claim so the retry
    // doesn't burn the daily cap...
    await db.releaseOneTimeBroadcast(SELLER_PK, claimKey);
    expect(await countClaims()).toBe(0);

    // ...but the retry can re-claim WITHOUT the cap growing (the release
    // keeps budget intact)...
    const claim2 = await db.claimOneTimeBroadcastWithCap(
      SELLER_PK,
      claimKey,
      contentKey,
      DAILY_LIMIT,
      KEY_PREFIX
    );
    expect(claim2).toBe("claimed");

    // ...while the content-keyed recipient ledger still blocks re-delivery
    // to the already-emailed contact. The undelivered one CAN be claimed.
    const redeliver = await db.claimOneTimeBroadcastRecipient(
      SELLER_PK,
      contentKey,
      emailed
    );
    expect(redeliver).toBe(false);

    const resume = await db.claimOneTimeBroadcastRecipient(
      SELLER_PK,
      contentKey,
      unsent
    );
    expect(resume).toBe(true);

    // And a retry WITHOUT a release (claim still held, ambiguous failure)
    // gets "exists" — no fresh send authorization, no second claim row.
    const claim3 = await db.claimOneTimeBroadcastWithCap(
      SELLER_PK,
      claimKey,
      contentKey,
      DAILY_LIMIT,
      KEY_PREFIX
    );
    expect(claim3).toBe("exists");
    expect(await countClaims()).toBe(1);

    const ledger = await db.getOneTimeBroadcastRecipients(
      SELLER_PK,
      contentKey
    );
    expect(ledger?.sort()).toEqual([emailed, unsent].sort());
  }
);

maybeIt(
  "N concurrent per-recipient claims on one (pubkey, content, email): exactly one winner",
  async () => {
    const contentKey = "content-recipient-race";
    const email = "Race-Buyer@Example.com";

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        db.claimOneTimeBroadcastRecipient(SELLER_PK, contentKey, email)
      )
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((r) => r === false)).toHaveLength(19);
    expect(results.every((r) => r !== null)).toBe(true);

    // A release after a definite provider rejection frees exactly this
    // recipient so a later retry may re-attempt.
    await db.releaseOneTimeBroadcastRecipient(SELLER_PK, contentKey, email);
    const after = await db.claimOneTimeBroadcastRecipient(
      SELLER_PK,
      contentKey,
      email
    );
    expect(after).toBe(true);
  }
);
