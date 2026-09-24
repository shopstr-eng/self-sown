/**
 * @jest-environment node
 *
 * Real-database round-trip test for the persisted pending-Lightning-quote
 * store (mcp_lightning_quotes) — the coverage mocked-accessor suites (e.g.
 * verify-payment-contract.test.ts) CANNOT provide:
 *
 *   A quote written by savePendingLightningQuote must be readable by
 *   getPendingLightningQuote with every field intact, so a verify-payment
 *   poll landing after a redeploy/restart (or on another instance) still
 *   confirms a settled invoice. The accessors hold no process state, so a
 *   save → get round trip through the REAL Postgres IS the simulated
 *   restart: nothing survives in memory because nothing lives in memory.
 *
 * Also pinned here, because a regression in either would strand paid
 * invoices or leak rows:
 *   - an expired quote reads back as null AND its row is reaped;
 *   - deletePendingLightningQuote removes the row (settle cleanup);
 *   - a re-save for the same order id overwrites (upsert), never duplicates.
 *
 * GATED two ways (both skipped by default so the plain suite stays fast);
 * the suite is wired into `pnpm test:integration`:
 *
 *   RUN_TESTCONTAINERS=1              — spins up postgres:15-alpine via
 *                                       Testcontainers (CI with real Docker;
 *                                       NOT runnable in the Replit sandbox,
 *                                       which cannot bind container ports).
 *   MCP_LIGHTNING_TEST_DATABASE_URL=postgres://...
 *                                     — runs against an existing Postgres
 *                                       (e.g. a CI service database or the
 *                                       dev database). Test rows use unique
 *                                       per-run zz-lnqtest-<ts>-* order ids
 *                                       and are deleted afterwards (plus a
 *                                       sweep for stragglers from crashed
 *                                       runs); never touches real quotes.
 */

const RUN_CONTAINERS = process.env.RUN_TESTCONTAINERS === "1";
const EXTERNAL_DATABASE_URL = process.env.MCP_LIGHTNING_TEST_DATABASE_URL;
const RUN = RUN_CONTAINERS || !!EXTERNAL_DATABASE_URL;

import { initializeApiKeysTable } from "@/utils/mcp/auth";
import {
  claimPendingLightningQuote,
  deletePendingLightningQuote,
  getPendingLightningQuote,
  savePendingLightningQuote,
  type PendingLightningQuote,
} from "@/mcp/tools/purchase-tools";
import * as dbService from "@/utils/db/db-service";

const RUN_ID = `zz-lnqtest-${Date.now()}`;
const STRAGGLER_AGE_MS = 2 * 60 * 60 * 1000;

const describeLive = RUN ? describe : describe.skip;

function entry(
  suffix: string,
  overrides: Partial<PendingLightningQuote> = {}
): PendingLightningQuote {
  return {
    orderId: `${RUN_ID}-${suffix}`,
    quote: `quote_${suffix}`,
    mintUrl: "https://mint.example",
    amount: 1500,
    productId: "product-1",
    quantity: 2,
    inventoryVariantKey: "_default",
    discountCode: "CHEESE10",
    sellerPubkey: "ab".repeat(32),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

async function rawRow(orderId: string) {
  const client = await dbService.getDbPool().connect();
  try {
    const result = await client.query(
      `SELECT * FROM mcp_lightning_quotes WHERE order_id = $1`,
      [orderId]
    );
    return result.rows[0] ?? null;
  } finally {
    client.release();
  }
}

describeLive("pending Lightning quotes (LIVE Postgres)", () => {
  jest.setTimeout(300_000);

  let stopDatabase: (() => Promise<void>) | undefined;
  let previousDatabaseUrl: string | undefined;

  beforeAll(async () => {
    let databaseUrl: string;
    if (RUN_CONTAINERS) {
      const { PostgreSqlContainer } = await import(
        "@testcontainers/postgresql"
      );
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

    await initializeApiKeysTable();
    // Sweep stragglers from crashed earlier runs (this run's prefix is
    // unique, so concurrent runs can't delete each other's rows).
    const client = await dbService.getDbPool().connect();
    try {
      await client.query(
        `DELETE FROM mcp_lightning_quotes
         WHERE order_id LIKE 'zz-lnqtest-%'
           AND created_at < $1`,
        [new Date(Date.now() - STRAGGLER_AGE_MS).toISOString()]
      );
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    const client = await dbService.getDbPool().connect();
    try {
      await client.query(
        `DELETE FROM mcp_lightning_quotes WHERE order_id LIKE $1`,
        [`${RUN_ID}-%`]
      );
    } finally {
      client.release();
    }
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
    if (stopDatabase) await stopDatabase();
  });

  it("round-trips a saved quote with every field intact (the post-restart read)", async () => {
    const saved = entry("roundtrip");
    await savePendingLightningQuote(saved);

    const loaded = await getPendingLightningQuote(saved.orderId);
    expect(loaded).toEqual(saved);
    // amount crosses the BIGINT boundary as a real number, not a string.
    expect(typeof loaded?.amount).toBe("number");
  });

  it("omits optional discount/seller fields when they were never set", async () => {
    const saved = entry("minimal", {
      discountCode: undefined,
      sellerPubkey: undefined,
    });
    await savePendingLightningQuote(saved);

    const loaded = await getPendingLightningQuote(saved.orderId);
    expect(loaded).toEqual(saved);
    expect(loaded).not.toHaveProperty("discountCode");
    expect(loaded).not.toHaveProperty("sellerPubkey");
  });

  it("retains an expired quote row (late-settlement reconciliation grace period)", async () => {
    // A payment in flight at the deadline can still settle, so expiry alone
    // must NEVER delete the row — the mint's quote state is the only
    // settlement authority. The route decides what an expired read means.
    const expired = entry("expired", {
      expiresAt: new Date(Date.now() - 60 * 1000).toISOString(),
    });
    await savePendingLightningQuote(expired);

    const loaded = await getPendingLightningQuote(expired.orderId);
    expect(loaded).toEqual(expired);
  });

  it("claim is atomic: exactly one of two concurrent claims wins", async () => {
    const saved = entry("claim-race");
    await savePendingLightningQuote(saved);

    // Two polls racing (retries, or two server instances sharing the DB):
    // both UPDATE the same row; the row lock serializes them and the WHERE
    // clause lets only the first through.
    const [first, second] = await Promise.all([
      claimPendingLightningQuote(saved.orderId),
      claimPendingLightningQuote(saved.orderId),
    ]);
    const winners = [first, second].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.orderId).toBe(saved.orderId);
  });

  it("a fresh claim blocks re-claim; a stale claim can be re-taken (crash-safe retry)", async () => {
    const saved = entry("claim-stale");
    await savePendingLightningQuote(saved);

    expect(await claimPendingLightningQuote(saved.orderId)).not.toBeNull();
    // Fresh claim held by the (possibly crashed) winner: nobody else yet.
    expect(await claimPendingLightningQuote(saved.orderId)).toBeNull();

    // Simulate the winner having died long ago: backdate the claim past the
    // stale window, then a retrying poll must be able to take over.
    const client = await dbService.getDbPool().connect();
    try {
      await client.query(
        `UPDATE mcp_lightning_quotes SET claimed_at = $1 WHERE order_id = $2`,
        [
          new Date(Date.now() - 10 * 60 * 1000).toISOString(),
          saved.orderId,
        ]
      );
    } finally {
      client.release();
    }
    expect(await claimPendingLightningQuote(saved.orderId)).not.toBeNull();
  });

  it("deletePendingLightningQuote removes the row (settle cleanup)", async () => {
    const saved = entry("delete");
    await savePendingLightningQuote(saved);
    expect(await getPendingLightningQuote(saved.orderId)).not.toBeNull();

    await deletePendingLightningQuote(saved.orderId);
    expect(await getPendingLightningQuote(saved.orderId)).toBeNull();
    expect(await rawRow(saved.orderId)).toBeNull();
  });

  it("re-saving the same order id overwrites instead of duplicating", async () => {
    const first = entry("upsert", { quote: "quote_old", amount: 100 });
    const second = entry("upsert", { quote: "quote_new", amount: 200 });
    await savePendingLightningQuote(first);
    await savePendingLightningQuote(second);

    const loaded = await getPendingLightningQuote(second.orderId);
    expect(loaded?.quote).toBe("quote_new");
    expect(loaded?.amount).toBe(200);

    const client = await dbService.getDbPool().connect();
    try {
      const count = await client.query(
        `SELECT COUNT(*)::int AS n FROM mcp_lightning_quotes WHERE order_id = $1`,
        [second.orderId]
      );
      expect(count.rows[0].n).toBe(1);
    } finally {
      client.release();
    }
  });
});
