/**
 * @jest-environment node
 */

// Real-database concurrency tests for the Cashu escrow outbox — the
// money-safety guarantees that the fake-pool suite in
// cashu-escrow-service.test.ts CANNOT prove:
//
//   1. claimEscrowOutboxEntry: N truly concurrent claims race the atomic
//      UPDATE...WHERE status guard on one row — exactly one worker wins.
//   2. enqueueEscrowAction: a release and a refund enqueued concurrently
//      serialize on the registration's FOR UPDATE row lock, so opposite
//      actions can never both become payable.
//   3. finalizeEscrowOutboxEntry: a double finalize (retry vs. retry, or a
//      stale fenced-out worker vs. the current claim holder) can never
//      resolve the escrow twice — the conditional locked→terminal
//      transition in one transaction makes the loser fail.
//
// Two ways to run (both skipped by default so the plain suite stays fast):
//
//   RUN_TESTCONTAINERS=1            — spins up postgres:15-alpine via
//                                     Testcontainers (CI with real Docker;
//                                     NOT runnable in the Replit sandbox,
//                                     which cannot bind container ports).
//   ESCROW_CONCURRENCY_TEST_DATABASE_URL=postgres://...
//                                   — runs against an existing Postgres
//                                     (e.g. a CI service database or the dev
//                                     database). Test rows use a synthetic
//                                     all-"a" buyer pubkey and are deleted
//                                     after each test.
//
// Either way the schema comes from initializeTables() (the authoritative
// runtime bootstrap), so drift between the schema and the service's SQL
// fails here.

jest.setTimeout(300000);

// Module marker: keeps the type aliases below out of the global script
// scope (lifetime-settle-db.test.ts declares similar names).
export {};

type DbServiceModule = typeof import("../db-service");
type EscrowServiceModule = typeof import("../cashu-escrow-service");
type EscrowCommitment =
  import("@/utils/cashu/escrow-commitment").EscrowCommitment;

const RUN_CONTAINERS = process.env.RUN_TESTCONTAINERS === "1";
const EXTERNAL_DATABASE_URL = process.env.ESCROW_CONCURRENCY_TEST_DATABASE_URL;
const SHOULD_RUN = RUN_CONTAINERS || Boolean(EXTERNAL_DATABASE_URL);

const maybeItTc = SHOULD_RUN ? test : test.skip;

const ESCROW_TABLES = ["cashu_escrow_registrations", "cashu_escrow_outbox"];

const BUYER_PK = "a".repeat(64);
const SELLER_PK = "b".repeat(64);
const ARBITER_PK = "c".repeat(64);

let db: DbServiceModule;
let escrow: EscrowServiceModule;
let stopDatabase: (() => Promise<void>) | null = null;
let previousDatabaseUrl: string | undefined;
let createdEscrowIds: string[] = [];

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

  // Load db-service AND cashu-escrow-service inside one isolated module
  // context so they share the same connection pool (the escrow service
  // imports getDbPool from db-service). Importing them separately would
  // build two pools.
  await jest.isolateModulesAsync(async () => {
    jest.resetModules();
    jest.unmock("pg");
    db = await import("../db-service");
    escrow = await import("../cashu-escrow-service");
  });

  await waitForTables(ESCROW_TABLES);

  // Clear any rows left behind by an interrupted previous run.
  await cleanupTestEscrows([`${BUYER_PK}:%`], true);
}, 300000);

afterAll(async () => {
  if (!SHOULD_RUN) return;
  try {
    await cleanupTestEscrows([`${BUYER_PK}:%`], true);
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

beforeEach(() => {
  createdEscrowIds = [];
});

afterEach(async () => {
  if (!SHOULD_RUN || createdEscrowIds.length === 0) return;
  await cleanupTestEscrows(createdEscrowIds, false);
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

      if (result.rows.length === tableNames.length) {
        return;
      }
    } finally {
      client.release();
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for tables: ${tableNames.join(", ")}`);
}

/** Deletes test escrow rows — exact ids, or a LIKE pattern when patterns=true. */
async function cleanupTestEscrows(
  ids: string[],
  patterns: boolean
): Promise<void> {
  const pool = db.getDbPool();
  if (patterns) {
    await pool.query(
      `DELETE FROM cashu_escrow_outbox WHERE escrow_id LIKE ANY($1)`,
      [ids]
    );
    await pool.query(
      `DELETE FROM cashu_escrow_registrations WHERE escrow_id LIKE ANY($1)`,
      [ids]
    );
  } else {
    await pool.query(
      `DELETE FROM cashu_escrow_outbox WHERE escrow_id = ANY($1)`,
      [ids]
    );
    await pool.query(
      `DELETE FROM cashu_escrow_registrations WHERE escrow_id = ANY($1)`,
      [ids]
    );
  }
}

function makeCommitment(orderId: string): {
  escrowId: string;
  commitment: EscrowCommitment;
  event: { id: string; pubkey: string };
} {
  const commitment: EscrowCommitment = {
    buyerPubkey: BUYER_PK,
    sellerPubkey: SELLER_PK,
    orderId,
    amountSats: 5_000,
    mintUrl: "https://mint.example",
    arbiterPubkey: ARBITER_PK,
    expiresAt: Math.floor(Date.now() / 1000) + 86_400,
  };
  return {
    escrowId: `${commitment.buyerPubkey}:${commitment.orderId}`,
    commitment,
    // The service only persists this as JSONB; a minimal shape suffices.
    event: { id: `evt-${orderId}`, pubkey: BUYER_PK },
  };
}

async function registerEscrow(orderId: string): Promise<string> {
  const { escrowId, commitment, event } = makeCommitment(orderId);
  await escrow.registerEscrowCommitment(escrowId, commitment, event as never);
  createdEscrowIds.push(escrowId);
  return escrowId;
}

describe("cashu-escrow-service concurrency (real Postgres)", () => {
  maybeItTc(
    "exactly one of many truly concurrent claims wins the outbox entry",
    async () => {
      const escrowId = await registerEscrow("claim-race");
      const { outboxId } = await escrow.enqueueEscrowAction(
        escrowId,
        "release"
      );

      // Pool has max 10 connections; 8 concurrent claims means several
      // statements genuinely in flight at once against the same row.
      const claimants = await Promise.all(
        Array.from({ length: 8 }, () => escrow.claimEscrowOutboxEntry(outboxId))
      );

      const winners = claimants.filter((c) => c !== null);
      expect(winners).toHaveLength(1);
      expect(claimants.filter((c) => c === null)).toHaveLength(7);

      const winner = winners[0]!;
      expect(winner).toMatchObject({
        outboxId,
        escrowId,
        action: "release",
        status: "processing",
        // One atomic increment despite the race.
        attempts: 1,
      });

      // No further claim succeeds while the winner holds it.
      expect(await escrow.claimEscrowOutboxEntry(outboxId)).toBeNull();

      // The durable row matches: one processing row, one attempt.
      const pool = db.getDbPool();
      const rows = await pool.query(
        `SELECT status, attempts, claim_token FROM cashu_escrow_outbox
         WHERE outbox_id = $1`,
        [outboxId]
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].status).toBe("processing");
      expect(Number(rows.rows[0].attempts)).toBe(1);
      expect(rows.rows[0].claim_token).toBe(winner.claimToken);
    }
  );

  maybeItTc(
    "racing opposite actions (release vs refund) can never both be enqueued",
    async () => {
      // Repeat across several escrows: the FOR UPDATE serialization must
      // hold on every interleaving, not just one lucky schedule.
      for (let round = 0; round < 5; round += 1) {
        const escrowId = await registerEscrow(`opp-race-${round}`);

        const results = await Promise.allSettled([
          escrow.enqueueEscrowAction(escrowId, "release"),
          escrow.enqueueEscrowAction(escrowId, "refund"),
        ]);

        const fulfilled = results.filter((r) => r.status === "fulfilled");
        const rejected = results.filter((r) => r.status === "rejected");

        // At least one enqueue always succeeds; the loser either threw
        // ("already has a pending <action>") after losing the FOR UPDATE
        // race, or is a same-action no-op. It must never have enqueued a
        // SECOND row.
        expect(fulfilled.length).toBeGreaterThanOrEqual(1);
        const enqueuedCount = fulfilled.filter(
          (r) =>
            (r as PromiseFulfilledResult<{ enqueued: boolean }>).value.enqueued
        ).length;
        expect(enqueuedCount).toBe(1);
        for (const r of rejected) {
          expect((r as PromiseRejectedResult).reason.message).toMatch(
            /already has a pending/
          );
        }

        // Durable state: exactly ONE outbox row for this escrow, with
        // exactly ONE action, and the escrow still locked (nothing paid).
        const pool = db.getDbPool();
        const rows = await pool.query(
          `SELECT action, status FROM cashu_escrow_outbox
           WHERE escrow_id = $1`,
          [escrowId]
        );
        expect(rows.rows).toHaveLength(1);
        expect(["release", "refund"]).toContain(rows.rows[0].action);
        expect(rows.rows[0].status).toBe("pending");

        // Whichever action won, the opposite action is rejected forever.
        const winner = rows.rows[0].action as "release" | "refund";
        const opposite = winner === "release" ? "refund" : "release";
        await expect(
          escrow.enqueueEscrowAction(escrowId, opposite)
        ).rejects.toThrow(/already has a pending/);
      }
    }
  );

  maybeItTc(
    "double finalize fails: two concurrent finalizes with the same fencing token resolve the escrow exactly once",
    async () => {
      const escrowId = await registerEscrow("double-finalize");
      const { outboxId } = await escrow.enqueueEscrowAction(
        escrowId,
        "release"
      );
      const claim = await escrow.claimEscrowOutboxEntry(outboxId);
      expect(claim).not.toBeNull();

      // A retried finalize racing the original: same token, both see the
      // row processing. Postgres row locking makes one win; the other
      // must fail rather than resolve the escrow a second time.
      const results = await Promise.allSettled([
        escrow.finalizeEscrowOutboxEntry(outboxId, claim!.claimToken),
        escrow.finalizeEscrowOutboxEntry(outboxId, claim!.claimToken),
      ]);
      const succeeded = results.filter((r) => r.status === "fulfilled");
      const failed = results.filter((r) => r.status === "rejected");
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect((failed[0] as PromiseRejectedResult).reason.message).toMatch(
        /not held by this worker/
      );

      // Any later finalize attempt also fails.
      await expect(
        escrow.finalizeEscrowOutboxEntry(outboxId, claim!.claimToken)
      ).rejects.toThrow(/not held by this worker/);

      const registration = await escrow.getEscrowRegistration(escrowId);
      expect(registration!.status).toBe("released");
    }
  );

  maybeItTc(
    "a stale worker fenced out by a reclaim can never finalize, and the reclaiming worker pays exactly once",
    async () => {
      const escrowId = await registerEscrow("fencing-race");
      const { outboxId } = await escrow.enqueueEscrowAction(escrowId, "refund");

      const staleWorker = await escrow.claimEscrowOutboxEntry(outboxId);
      expect(staleWorker).not.toBeNull();

      // Force the claim stale instead of waiting out the 15-minute window.
      const pool = db.getDbPool();
      await pool.query(
        `UPDATE cashu_escrow_outbox
         SET claimed_at = NOW() - INTERVAL '1 hour'
         WHERE outbox_id = $1`,
        [outboxId]
      );

      // Two fresh workers race the reclaim of the stale entry.
      const reclaimers = await Promise.all([
        escrow.claimEscrowOutboxEntry(outboxId),
        escrow.claimEscrowOutboxEntry(outboxId),
      ]);
      const reclaimWinners = reclaimers.filter((c) => c !== null);
      expect(reclaimWinners).toHaveLength(1);
      const newWorker = reclaimWinners[0]!;
      expect(newWorker.claimToken).not.toBe(staleWorker!.claimToken);
      expect(newWorker.attempts).toBe(2);

      // The stale worker is fenced out of every write path.
      await expect(
        escrow.finalizeEscrowOutboxEntry(outboxId, staleWorker!.claimToken)
      ).rejects.toThrow(/not held by this worker/);
      await expect(
        escrow.releaseEscrowOutboxClaim(
          outboxId,
          staleWorker!.claimToken,
          "late"
        )
      ).resolves.toBe(false);
      await expect(
        escrow.saveEscrowPreparedOutputs(outboxId, staleWorker!.claimToken, [
          { blindedMessage: { amount: "4", id: "k", B_: "ab" } },
        ])
      ).resolves.toBe(false);

      // The current claim holder completes the payout exactly once.
      await escrow.finalizeEscrowOutboxEntry(outboxId, newWorker.claimToken);
      const registration = await escrow.getEscrowRegistration(escrowId);
      expect(registration!.status).toBe("refunded");

      // And even the winning worker cannot finalize twice.
      await expect(
        escrow.finalizeEscrowOutboxEntry(outboxId, newWorker.claimToken)
      ).rejects.toThrow(/not held by this worker/);
    }
  );

  maybeItTc(
    "an enqueue racing a finalize can never create a second payable action for a resolved escrow",
    async () => {
      const escrowId = await registerEscrow("finalize-enqueue-race");
      const { outboxId } = await escrow.enqueueEscrowAction(
        escrowId,
        "release"
      );
      const claim = await escrow.claimEscrowOutboxEntry(outboxId);
      expect(claim).not.toBeNull();

      // A refund enqueue racing the release finalize. The two transactions
      // lock the outbox and registration rows in OPPOSITE order, so
      // Postgres deadlock detection may abort one of them — that is a
      // fail-closed, retryable outcome, NOT a double-pay. What must hold
      // in every interleaving: the escrow resolves at most once and the
      // outbox never gains a second row.
      const results = await Promise.allSettled([
        escrow.finalizeEscrowOutboxEntry(outboxId, claim!.claimToken),
        escrow.enqueueEscrowAction(escrowId, "refund"),
      ]);

      const [finalizeResult, enqueueResult] = results;

      // The refund enqueue must never succeed: the outbox row already
      // carries the release action (and once finalized the escrow is no
      // longer locked), so it is rejected — or, rarely, deadlock-aborted.
      expect(enqueueResult.status).toBe("rejected");
      expect((enqueueResult as PromiseRejectedResult).reason.message).toMatch(
        /already released|already has a pending|deadlock detected/
      );

      if (finalizeResult.status === "rejected") {
        // Deadlock victim: fail-closed and retryable. The claim is still
        // held by this worker, so completing the payout must succeed.
        expect(
          (finalizeResult as PromiseRejectedResult).reason.message
        ).toMatch(/deadlock detected/);
        await escrow.finalizeEscrowOutboxEntry(outboxId, claim!.claimToken);
      }

      // Final durable state: exactly one outbox row (the release, done)
      // and the escrow released exactly once.
      const pool = db.getDbPool();
      const rows = await pool.query(
        `SELECT action, status FROM cashu_escrow_outbox WHERE escrow_id = $1`,
        [escrowId]
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].action).toBe("release");
      expect(rows.rows[0].status).toBe("done");

      const registration = await escrow.getEscrowRegistration(escrowId);
      expect(registration!.status).toBe("released");

      // The opposite action remains rejected after resolution.
      await expect(
        escrow.enqueueEscrowAction(escrowId, "refund")
      ).rejects.toThrow(/already released|already has a pending/);
    }
  );
});
