/**
 * @jest-environment node
 *
 * Real-SQL coverage for multi-seller subscription split-record cleanup
 * (#434): card PaymentIntent split rows must survive pruning forever (a
 * succeeded PI can reach process-transfers indefinitely), but a
 * subscription's split record is only needed while the subscription can
 * still renew. Pins: markPendingSubscriptionTerminal flags only
 * split-carrying rows and preserves their metadata; pruneStripePendingPayments
 * deletes a terminal-marked row past the grace window while an active
 * subscription's record and a recently-cancelled one survive; the pre-existing
 * rules (plain terminal rows pruned, unmarked split rows never pruned) hold.
 * Exercises the real pending-payments functions against pg-mem (harness
 * pattern from blog-broadcast-segments.test.ts).
 */

import type { IMemoryDb } from "pg-mem";

jest.mock("pg", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { newDb: makeDb } = require("pg-mem");
  const memDb: IMemoryDb = makeDb({ noAstCoverageCheck: true });
  memDb.public.none(`
    CREATE TABLE stripe_pending_payments (
      intent_ref TEXT PRIMARY KEY,
      payment_intent_id TEXT,
      amount BIGINT NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_error_message TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      claim_token TEXT
    );
  `);

  const { Pool: MemPool } = memDb.adapters.createPg();

  function wrapClient(raw: any) {
    return {
      release() {
        if (typeof raw.release === "function") raw.release();
      },
      async query(sql: string, params?: any[]) {
        // Skip the runtime schema bootstrap (incl. the advisory lock and
        // BEGIN/COMMIT wrappers); this test creates the only table it
        // exercises.
        if (
          /CREATE TABLE IF NOT EXISTS|ALTER TABLE|CREATE INDEX|CREATE UNIQUE INDEX|DO \$\$/i.test(
            sql
          )
        ) {
          return { rows: [], rowCount: 0 };
        }
        if (!/stripe_pending_payments/i.test(sql)) {
          return { rows: [], rowCount: 0 };
        }
        return raw.query(sql, params);
      },
    };
  }

  class WrappedPool {
    private inner: any;
    constructor(...args: any[]) {
      this.inner = new MemPool(...args);
    }
    on() {
      return this;
    }
    async connect() {
      const raw = await this.inner.connect();
      return wrapClient(raw);
    }
    async query(sql: string, params?: any[]) {
      const raw = await this.inner.connect();
      const client = wrapClient(raw);
      try {
        return await client.query(sql, params);
      } finally {
        client.release();
      }
    }
    async end() {
      if (typeof this.inner.end === "function") await this.inner.end();
    }
  }

  return { __memDb: memDb, Pool: WrappedPool };
});

// db-service lazily builds its pool from DATABASE_URL, so a syntactically
// valid URL must be present even though pg-mem never uses it.
process.env.DATABASE_URL =
  "postgresql://user:pass@ep-test-instance.us-east-2.aws.neon.tech/neondb";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const memDb: IMemoryDb = (require("pg") as any).__memDb;

import {
  getPendingPayment,
  markPendingSubscriptionTerminal,
  pruneStripePendingPayments,
  SUBSCRIPTION_TERMINAL_METADATA_KEY,
} from "@/utils/stripe/pending-payments";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const OLD = NOW - 60 * DAY_MS;

const SPLITS_METADATA = {
  transferGroup: "cart_sub_abc123",
  sellerSplits: [
    { pubkey: "a".repeat(64), amountCents: 1000, accountId: "acct_1" },
    { pubkey: "b".repeat(64), amountCents: 2000, accountId: "acct_2" },
  ],
  kind: "cart-subscription",
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Pool: TestPool } = require("pg");
const testPool = new TestPool();

async function insertRow(row: {
  intentRef: string;
  status: string;
  metadata: Record<string, unknown>;
  updatedAt: number;
  paymentIntentId?: string | null;
}) {
  // Parameterized: pg-mem's raw SQL parser rejects dollar-quoted JSON
  // literals, but the adapter binds query parameters fine.
  await testPool.query(
    `INSERT INTO stripe_pending_payments
      (intent_ref, payment_intent_id, amount, currency, status, metadata, created_at, updated_at)
     VALUES ($1, $2, 3000, 'usd', $3, $4::jsonb, $5, $5)`,
    [
      row.intentRef,
      row.paymentIntentId ?? null,
      row.status,
      JSON.stringify(row.metadata),
      row.updatedAt,
    ]
  );
}

function rowCountFor(intentRef: string): number {
  const { rows } = memDb.public.query(
    `SELECT COUNT(*)::int AS n FROM stripe_pending_payments WHERE intent_ref = '${intentRef}'`
  );
  return rows[0].n;
}

describe("markPendingSubscriptionTerminal", () => {
  it("flags a split-carrying subscription record and preserves its split details", async () => {
    await insertRow({
      intentRef: "cart_sub_mark_me",
      status: "created",
      metadata: { ...SPLITS_METADATA },
      updatedAt: OLD,
    });

    const marked = await markPendingSubscriptionTerminal("cart_sub_mark_me");
    expect(marked).toBe(true);

    const record = await getPendingPayment("cart_sub_mark_me");
    expect(record).not.toBeNull();
    expect(record!.metadata[SUBSCRIPTION_TERMINAL_METADATA_KEY]).toEqual(
      expect.any(Number)
    );
    // The merge must not clobber the payout details a late invoice.paid
    // still needs.
    expect(record!.metadata.sellerSplits).toEqual(SPLITS_METADATA.sellerSplits);
    expect(record!.metadata.transferGroup).toBe("cart_sub_abc123");
  });

  it("is a no-op for a missing row, a record without sellerSplits, or a non-subscription record", async () => {
    await insertRow({
      intentRef: "plain_card_record",
      status: "succeeded",
      metadata: { kind: "card-checkout" },
      updatedAt: OLD,
    });
    // A CARD multi-seller record: sellerSplits present but no
    // cart-subscription discriminator — its payout authority must never
    // become prunable (process-transfers can be reached indefinitely).
    await insertRow({
      intentRef: "card_split_no_kind",
      status: "succeeded",
      metadata: { sellerSplits: SPLITS_METADATA.sellerSplits },
      updatedAt: OLD,
      paymentIntentId: "pi_card_no_kind",
    });

    await expect(
      markPendingSubscriptionTerminal("cart_sub_does_not_exist")
    ).resolves.toBe(false);
    await expect(
      markPendingSubscriptionTerminal("plain_card_record")
    ).resolves.toBe(false);
    await expect(
      markPendingSubscriptionTerminal("card_split_no_kind")
    ).resolves.toBe(false);

    const plain = await getPendingPayment("plain_card_record");
    expect(plain!.metadata[SUBSCRIPTION_TERMINAL_METADATA_KEY]).toBeUndefined();
    const cardSplit = await getPendingPayment("card_split_no_kind");
    expect(
      cardSplit!.metadata[SUBSCRIPTION_TERMINAL_METADATA_KEY]
    ).toBeUndefined();
  });
});

describe("pruneStripePendingPayments", () => {
  it("deletes a cancelled subscription's split record past the grace window but keeps an active one", async () => {
    await insertRow({
      intentRef: "cart_sub_cancelled_old",
      status: "created",
      metadata: { ...SPLITS_METADATA, [SUBSCRIPTION_TERMINAL_METADATA_KEY]: OLD },
      updatedAt: OLD,
    });
    await insertRow({
      intentRef: "cart_sub_active_old",
      status: "created",
      metadata: { ...SPLITS_METADATA },
      updatedAt: OLD,
    });

    // Exact delete counts are not asserted: the suite shares one pg-mem
    // database, so rows inserted by earlier tests may also be swept.
    await pruneStripePendingPayments();
    expect(rowCountFor("cart_sub_cancelled_old")).toBe(0);
    expect(rowCountFor("cart_sub_active_old")).toBe(1);
  });

  it("keeps a recently-cancelled subscription's record inside the grace window", async () => {
    await insertRow({
      intentRef: "cart_sub_cancelled_recent",
      status: "created",
      metadata: { ...SPLITS_METADATA },
      updatedAt: OLD,
    });
    await markPendingSubscriptionTerminal("cart_sub_cancelled_recent");

    await pruneStripePendingPayments();
    expect(rowCountFor("cart_sub_cancelled_recent")).toBe(1);
  });

  it("still never prunes an unmarked card split record, and still prunes plain terminal rows", async () => {
    await insertRow({
      intentRef: "card_split_succeeded_old",
      status: "succeeded",
      metadata: { ...SPLITS_METADATA },
      updatedAt: OLD,
      paymentIntentId: "pi_card_split",
    });
    await insertRow({
      intentRef: "plain_succeeded_old",
      status: "succeeded",
      metadata: { kind: "card-checkout" },
      updatedAt: OLD,
    });

    await pruneStripePendingPayments();
    expect(rowCountFor("card_split_succeeded_old")).toBe(1);
    expect(rowCountFor("plain_succeeded_old")).toBe(0);
  });

  it("never prunes a card split record even if a terminal key lands in its metadata", async () => {
    // Defense in depth: client metadata is stripped of the server-owned
    // terminal key at the create-payment-intent boundary, but even a record
    // that somehow carries it must not be swept without the server-stamped
    // cart-subscription discriminator.
    await insertRow({
      intentRef: "card_split_injected_terminal",
      status: "succeeded",
      metadata: {
        sellerSplits: SPLITS_METADATA.sellerSplits,
        [SUBSCRIPTION_TERMINAL_METADATA_KEY]: OLD,
      },
      updatedAt: OLD,
      paymentIntentId: "pi_card_injected",
    });

    await pruneStripePendingPayments();
    expect(rowCountFor("card_split_injected_terminal")).toBe(1);
  });
});
