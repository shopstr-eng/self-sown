/** @jest-environment node */

/**
 * LIVE schema-regression verification for shipping_label_order_claims: the
 * card auto-purchase flow deliberately holds TWO claims per order — a
 * payment-bound replay guard (`payment:<seller>:<ref>`) AND the order-bound
 * guard shared with the manual/mobile route (`outbound:<seller>:<orderId>`).
 * A unique index or dedup migration on (pubkey, order_id) breaks that pattern
 * and silently discards the payment-bound replay guard. This suite proves
 * against REAL Postgres (not mocks, which can't see schema constraints) that:
 *
 *  1. Both claims for the same (pubkey, order_id) can be held at once.
 *  2. The same payment-bound key can never be claimed twice (replay guard).
 *  3. The order-bound key conflicts across flows (cross-flow dedup), and
 *     releasing it reopens the order for the manual/mobile flow.
 *
 * GATED: runs ONLY when SHIPPING_CLAIMS_TEST_DATABASE_URL is explicitly set.
 * Each test uses its own unique zz-claimtest-<ts>-* order id and deletes only
 * its own rows afterwards; never touches real claims.
 */

const RUN = !!process.env.SHIPPING_CLAIMS_TEST_DATABASE_URL;
// The pool is built lazily on first use, so overriding DATABASE_URL here —
// before any test runs — is enough.
if (RUN) {
  process.env.DATABASE_URL = process.env.SHIPPING_CLAIMS_TEST_DATABASE_URL;
}

import {
  claimAutoLabelPurchase,
  claimOutboundLabelPurchase,
  releaseAutoLabelClaim,
} from "@/utils/db/shipping-service";
import { getDbPool } from "@/utils/db/db-service";

const RUN_ID = `zz-claimtest-${Date.now()}`;
const PUBKEY = "f".repeat(64);

let caseSeq = 0;
const orderIdsInUse: string[] = [];

function newCase() {
  const orderId = `${RUN_ID}-${caseSeq++}-order`;
  orderIdsInUse.push(orderId);
  return {
    orderId,
    paymentKey: `payment:${PUBKEY}:${RUN_ID}-${caseSeq}-pi`,
    orderKey: `outbound:${PUBKEY}:${orderId}`,
  };
}

const describeLive = RUN ? describe : describe.skip;

describeLive("shipping label order claims (live Postgres)", () => {
  afterAll(async () => {
    const pool = getDbPool();
    await pool.query(
      `DELETE FROM shipping_label_order_claims WHERE order_id = ANY($1)`,
      [orderIdsInUse]
    );
    await pool.query(
      `DELETE FROM shipping_outbound_order_claims WHERE order_id = ANY($1)`,
      [orderIdsInUse]
    );
  });

  it("holds a payment-bound AND an order-bound claim for the same order at once", async () => {
    // The exact sequence runAutoLabelPurchase performs for a card order: the
    // payment-bound claim first, then the order-bound claim. A unique index
    // on (pubkey, order_id) would make the second insert always fail.
    const c = newCase();
    await expect(
      claimAutoLabelPurchase(c.paymentKey, PUBKEY, c.orderId)
    ).resolves.toBe(true);
    await expect(
      claimAutoLabelPurchase(c.orderKey, PUBKEY, c.orderId)
    ).resolves.toBe(true);
  });

  it("never lets the same payment-bound key be claimed twice", async () => {
    const c = newCase();
    await expect(
      claimAutoLabelPurchase(c.paymentKey, PUBKEY, c.orderId)
    ).resolves.toBe(true);
    await expect(
      claimAutoLabelPurchase(c.paymentKey, PUBKEY, c.orderId)
    ).resolves.toBe(false);
  });

  it("blocks the manual/mobile outbound claim while the order-bound key exists, and reopens it after release", async () => {
    const c = newCase();
    // Auto-purchase path takes the shared order-bound key first.
    await expect(
      claimAutoLabelPurchase(c.orderKey, PUBKEY, c.orderId)
    ).resolves.toBe(true);
    // claimOutboundLabelPurchase dual-writes the legacy table with claim_key
    // `outbound:<pubkey>:<orderId>` — already held — so the whole transaction
    // must roll back.
    await expect(claimOutboundLabelPurchase(PUBKEY, c.orderId)).resolves.toBe(
      false
    );
    // After the claim is released (definitive failure), the outbound flow can
    // take the order.
    await releaseAutoLabelClaim(c.orderKey);
    await expect(claimOutboundLabelPurchase(PUBKEY, c.orderId)).resolves.toBe(
      true
    );
  });
});
