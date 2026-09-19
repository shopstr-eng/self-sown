/**
 * @jest-environment node
 *
 * Real-SQL coverage for multi-line subscriptions (#429): a multi-seller
 * recurring cart creates ONE Stripe subscription but persists ONE
 * subscriptions row per recurring item, so stripe_subscription_id alone is
 * not unique — the composite (stripe_subscription_id, product_event_id) is.
 * Pins: two items sharing one Stripe subscription id both persist, a retry
 * re-insert is a no-op (ON CONFLICT DO NOTHING), and status updates apply
 * to every row of the subscription. Exercises the real createSubscription /
 * getSubscription(s)ByStripeId / updateSubscriptionStatus functions against
 * pg-mem (harness pattern from blog-broadcast-segments.test.ts).
 */

import type { IMemoryDb } from "pg-mem";

jest.mock("pg", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { newDb: makeDb } = require("pg-mem");
  const memDb: IMemoryDb = makeDb({ noAstCoverageCheck: true });
  memDb.public.none(`
    CREATE TABLE subscriptions (
      id SERIAL PRIMARY KEY,
      stripe_subscription_id TEXT NOT NULL,
      stripe_customer_id TEXT NOT NULL,
      buyer_pubkey TEXT,
      buyer_email TEXT NOT NULL,
      seller_pubkey TEXT NOT NULL,
      product_event_id TEXT NOT NULL,
      product_title TEXT,
      connected_account_id TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      variant_info JSONB,
      frequency TEXT NOT NULL,
      discount_percent DECIMAL(5,2) NOT NULL,
      base_price NUMERIC(12,2) NOT NULL,
      subscription_price NUMERIC(12,2) NOT NULL,
      currency TEXT NOT NULL DEFAULT 'usd',
      shipping_address JSONB,
      status TEXT NOT NULL DEFAULT 'active',
      next_billing_date TIMESTAMP,
      next_shipping_date TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (stripe_subscription_id, product_event_id)
    );
  `);

  const { Pool: MemPool } = memDb.adapters.createPg();

  function wrapClient(raw: any) {
    return {
      release() {
        if (typeof raw.release === "function") raw.release();
      },
      async query(sql: string, params?: any[]) {
        // Skip the runtime production-schema bootstrap; this test creates
        // the only table it exercises.
        if (
          /CREATE TABLE IF NOT EXISTS|ALTER TABLE|CREATE INDEX|CREATE UNIQUE INDEX|DO \$\$/i.test(
            sql
          )
        ) {
          return { rows: [], rowCount: 0 };
        }
        if (!/subscriptions/i.test(sql)) {
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
  createSubscription,
  getSubscriptionByStripeId,
  getSubscriptionsByStripeId,
  updateSubscriptionStatus,
} from "@/utils/db/db-service";

const STRIPE_SUB_ID = "sub_multi_seller_1";

function itemRow(productEventId: string, sellerPubkey: string) {
  return {
    stripe_subscription_id: STRIPE_SUB_ID,
    stripe_customer_id: "cus_buyer_1",
    buyer_pubkey: "c".repeat(64),
    buyer_email: "buyer@example.com",
    seller_pubkey: sellerPubkey,
    product_event_id: productEventId,
    product_title: `Product ${productEventId}`,
    connected_account_id: null,
    quantity: 1,
    frequency: "weekly",
    discount_percent: 10,
    base_price: 12.5,
    subscription_price: 11.25,
    currency: "usd",
    status: "incomplete",
  };
}

describe("multi-line subscription persistence", () => {
  it("persists one row per recurring item under a single Stripe subscription id", async () => {
    await createSubscription(itemRow("evt_milk", "a".repeat(64)));
    await createSubscription(itemRow("evt_eggs", "b".repeat(64)));

    const rows = await getSubscriptionsByStripeId(STRIPE_SUB_ID);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r: any) => r.seller_pubkey))).toEqual(
      new Set(["a".repeat(64), "b".repeat(64)])
    );

    // The single-row view stays deterministic (first-inserted row).
    const first = await getSubscriptionByStripeId(STRIPE_SUB_ID);
    expect((first as any).product_event_id).toBe("evt_milk");
  });

  it("treats a retry re-insert of the same item as a no-op, never a duplicate-key 500", async () => {
    // Same Stripe subscription id AND same product_event_id — exactly what a
    // buyer retry re-runs after the Stripe subscription already exists.
    await expect(
      createSubscription(itemRow("evt_milk", "a".repeat(64)))
    ).resolves.not.toThrow();

    const { rows } = await memDb.public.query(
      `SELECT COUNT(*)::int AS n FROM subscriptions WHERE stripe_subscription_id = '${STRIPE_SUB_ID}'`
    );
    expect(rows[0].n).toBe(2);
  });

  it("applies status updates to every per-item row of the subscription", async () => {
    await updateSubscriptionStatus(STRIPE_SUB_ID, "active");

    const rows = await getSubscriptionsByStripeId(STRIPE_SUB_ID);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect((row as any).status).toBe("active");
    }
  });
});
