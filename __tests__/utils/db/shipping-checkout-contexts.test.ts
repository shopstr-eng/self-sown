/**
 * @jest-environment node
 *
 * Real-SQL coverage (pg-mem; harness pattern from
 * stripe-pending-payments-prune.test.ts) for the checkout-time shipping
 * binding store behind the web auto-label routes. The money-safety invariant
 * pinned here: a binding is IMMUTABLE. The Stripe/Square creation idempotency
 * keys deliberately omit the shipping context, so a buyer can replay the same
 * payment-creation request after settlement with a swapped destination and
 * receive the SAME provider payment id — if the store overwrote on conflict,
 * that replay would redirect the seller-billed label. First write must win:
 * record A, replay B under the same (payment_ref, seller_pubkey), and the
 * lookup must still return A.
 */

import type { IMemoryDb } from "pg-mem";

jest.mock("pg", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { newDb: makeDb } = require("pg-mem");
  const memDb: IMemoryDb = makeDb({ noAstCoverageCheck: true });
  memDb.public.none(`
    CREATE TABLE shipping_checkout_contexts (
      payment_ref TEXT NOT NULL,
      seller_pubkey TEXT NOT NULL,
      order_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      to_address JSONB NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (payment_ref, seller_pubkey)
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
        if (!/shipping_checkout_contexts/i.test(sql)) {
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

import {
  getShippingCheckoutContext,
  recordShippingCheckoutContexts,
} from "@/utils/db/shipping-service";

const SELLER = "a".repeat(64);

const ADDRESS_A = {
  name: "Buyer Person",
  street1: "100 Buyer St",
  city: "Buyerville",
  state: "CA",
  zip: "90001",
  country: "US",
};

// The attacker's post-settlement replay: same payment, "new" destination and
// a heavier parcel profile.
const ADDRESS_B = {
  name: "Mule",
  street1: "1 Expensive Way",
  city: "Remote",
  state: "AK",
  zip: "99501",
  country: "US",
};

function contextA() {
  return {
    sellerPubkey: SELLER,
    orderId: "order-A",
    productId: "prod_evt_A",
    toAddress: ADDRESS_A,
  };
}

function contextB() {
  return {
    sellerPubkey: SELLER,
    orderId: "order-B",
    productId: "prod_evt_HEAVY",
    toAddress: ADDRESS_B,
  };
}

describe("shipping_checkout_contexts — checkout binding is immutable", () => {
  it("round-trips a recorded context", async () => {
    await recordShippingCheckoutContexts("stripe:pi_rt", [contextA()]);
    const got = await getShippingCheckoutContext("stripe:pi_rt", SELLER);
    expect(got).toMatchObject({
      sellerPubkey: SELLER,
      orderId: "order-A",
      productId: "prod_evt_A",
      toAddress: { street1: "100 Buyer St", zip: "90001", country: "US" },
    });
  });

  it("keeps the ORIGINAL binding when the same payment id is replayed with a swapped destination", async () => {
    // First write: the genuine checkout.
    await recordShippingCheckoutContexts("stripe:pi_replay", [contextA()]);
    // Replay: same provider payment id, attacker-changed order/product/address.
    await recordShippingCheckoutContexts("stripe:pi_replay", [contextB()]);

    const got = await getShippingCheckoutContext("stripe:pi_replay", SELLER);
    expect(got).toMatchObject({
      orderId: "order-A",
      productId: "prod_evt_A",
      toAddress: { street1: "100 Buyer St", zip: "90001" },
    });
    // Explicitly NOT the replayed values — an overwrite regression must fail.
    expect(got?.orderId).not.toBe("order-B");
    expect(got?.productId).not.toBe("prod_evt_HEAVY");
    expect(got?.toAddress.zip).not.toBe("99501");
  });

  it("scopes bindings by seller: a replay for one seller cannot touch another's row", async () => {
    const OTHER = "b".repeat(64);
    await recordShippingCheckoutContexts("stripe:pi_multi", [
      contextA(),
      { ...contextA(), sellerPubkey: OTHER },
    ]);
    // Replay targeting only the OTHER seller's row.
    await recordShippingCheckoutContexts("stripe:pi_multi", [
      { ...contextB(), sellerPubkey: OTHER },
    ]);

    expect(
      await getShippingCheckoutContext("stripe:pi_multi", SELLER)
    ).toMatchObject({ orderId: "order-A" });
    expect(
      await getShippingCheckoutContext("stripe:pi_multi", OTHER)
    ).toMatchObject({ orderId: "order-A" });
  });

  it("returns null for an unknown payment ref or seller", async () => {
    await recordShippingCheckoutContexts("stripe:pi_known", [contextA()]);
    await expect(
      getShippingCheckoutContext("stripe:pi_unknown", SELLER)
    ).resolves.toBeNull();
    await expect(
      getShippingCheckoutContext("stripe:pi_known", "c".repeat(64))
    ).resolves.toBeNull();
    // Cross-provider ids never collide.
    await expect(
      getShippingCheckoutContext("square:pi_known", SELLER)
    ).resolves.toBeNull();
  });
});
