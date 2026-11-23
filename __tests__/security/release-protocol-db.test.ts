/** @jest-environment node */
import { randomUUID } from "node:crypto";
import { createP2PKsecret, OutputData, signP2PKProof, type Proof } from "@cashu/cashu-ts";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import * as db from "@/utils/db/db-service";
import * as escrow from "@/utils/db/cashu-escrow-service";
import * as checkout from "@/utils/ucp/checkout-store";
import { processEscrowOutboxEntry } from "@/utils/cashu/escrow-payout-worker";
import { executeEscrowPayout, type EscrowPayoutMintWallet, type EscrowPayoutMintApi } from "@/utils/cashu/escrow-payout";
jest.mock("@/utils/cashu/escrow-config", () => ({ isEscrowEnabled: () => true }));

const databaseUrl = process.env.RELEASE_PROTOCOL_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
suite("release protocols against real Postgres and a controlled mint", () => {
  const prefix = `release-protocol-${randomUUID()}`;
  const buyer = "a".repeat(64);
  const sessionIds: string[] = [];
  const escrowIds: string[] = [];
  let keyId: number;
  let previousUrl: string | undefined;

  beforeAll(async () => {
    previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = databaseUrl;
    const pool = db.getDbPool();
    // Existing tables are not a readiness barrier when another test has
    // already bootstrapped this database. Await the whole DDL transaction.
    await db.ensureTablesInitialized();
    await checkout.initCheckoutSessionsTable();
    const result = await pool.query(
      "INSERT INTO mcp_api_keys (key_prefix,key_hash,name,pubkey) VALUES ($1,$2,$3,$4) RETURNING id",
      [prefix, prefix, prefix, buyer]
    );
    keyId = result.rows[0].id;
  }, 90_000);

  afterAll(async () => {
    const pool = db.getDbPool();
    await pool.query("DELETE FROM ucp_checkout_sessions WHERE id = ANY($1)", [sessionIds]);
    await pool.query("DELETE FROM cashu_escrow_outbox WHERE escrow_id = ANY($1)", [escrowIds]);
    await pool.query("DELETE FROM cashu_escrow_registrations WHERE escrow_id = ANY($1)", [escrowIds]);
    await pool.query("DELETE FROM mcp_api_keys WHERE id = $1", [keyId]);
    await db.closeDbPool();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  });

  it.each(["success", "pre-order-failure", "ambiguous", "success-write-failure"])(
    "keeps concurrent completion out of subscription retry settlement: %s",
    async (outcome) => {
      const id = `${prefix}-${outcome}`;
      sessionIds.push(id);
      await checkout.insertCheckoutSession({
        id, apiKeyId: keyId, buyerPubkey: buyer, sellerPubkey: "b".repeat(64),
        productId: "test", mcpOrderId: null, status: "requires_escalation",
        paymentMethod: "stripe", amountTotal: 4, currency: "usd",
        request: { subscription: true }, payment: null, quote: null, messages: [],
      });
      const claims = await Promise.all(Array.from({ length: 8 }, () =>
        checkout.claimCheckoutSessionRetry(id, buyer, keyId)));
      expect(claims.filter(Boolean)).toHaveLength(1);
      const completions = await Promise.all(Array.from({ length: 8 }, () =>
        checkout.updateCheckoutSessionStatus(id, "complete_in_progress", [], null, "incomplete")));
      expect(completions.every((row) => row === null)).toBe(true);
      if (outcome === "pre-order-failure") {
        const row = await checkout.failCheckoutSessionRetry(id, [], "before order", "test", "stripe");
        expect(row?.status).toBe("requires_escalation");
        expect(row?.retry_in_progress).toBe(false);
      } else if (outcome === "success") {
        // Subscription sessions can succeed without a one-time MCP order id.
        const row = await checkout.resolveCheckoutSessionRetry(id, {
          status: "ready_for_complete", messages: [], payment: { subscription: true },
          quote: null, mcpOrderId: null, amountTotal: 4, currency: "usd", paymentMethod: "stripe",
        });
        expect(row?.status).toBe("ready_for_complete");
        expect(row?.retry_in_progress).toBe(false);
        await checkout.updateCheckoutSessionStatus(id, "completed", [], null, "ready_for_complete");
        await expect(checkout.updateCheckoutSessionStatus(id, "incomplete", [], null, "completed")).resolves.toBeNull();
      } else {
        const row = await checkout.rescueCheckoutSessionRetry(id, {
          mcpOrderId: outcome === "ambiguous" ? null : `${prefix}-order`,
          messages: [], error: "outcome unknown", code: "test",
        });
        expect(row?.status).toBe("complete_in_progress");
        expect(row?.retry_in_progress).toBe(false);
        await expect(checkout.claimCheckoutSessionRetry(id, buyer, keyId)).resolves.toBeNull();
      }
    }
  );

  it("reproduces the old expiry data loss in a rolled-back transaction, then restores without another swap", async () => {
    const sellerSecret = generateSecretKey();
    const seller = getPublicKey(sellerSecret);
    const realBuyer = getPublicKey(generateSecretKey());
    const expiresAt = Math.floor(Date.now() / 1000) + 86_400;
    const afterExpiry = new Date((expiresAt + 1) * 1000);
    const id = `${realBuyer}:${prefix}`;
    escrowIds.push(id);
    await escrow.registerEscrowCommitment(id, {
      buyerPubkey: realBuyer, sellerPubkey: seller, orderId: prefix,
      amountSats: 4, mintUrl: "https://controlled-mint.example", expiresAt,
    }, { id: `${prefix}-event`, pubkey: realBuyer } as never);
    const keyset = "009a1f293253e41e";
    const point = () => `02${getPublicKey(generateSecretKey())}`;
    const proof = signP2PKProof({
      id: keyset, amount: 4, C: point(),
      secret: createP2PKsecret(seller, [["locktime", String(expiresAt)], ["refund", realBuyer]]),
    } as unknown as Proof, Buffer.from(sellerSecret).toString("hex"));
    await escrow.enqueueEscrowAction(id, "release", { proofs: [proof] });
    const output = OutputData.createSingleP2PKData({ pubkey: seller }, 4, keyset);
    let spent = false;
    const wallet: EscrowPayoutMintWallet = {
      loadMint: jest.fn(async () => {}),
      checkProofsStates: jest.fn(async () => [{ state: spent ? "SPENT" : "UNSPENT" }]) as never,
      prepareSwapToReceive: jest.fn(async () => ({ keepOutputs: [output] })) as never,
      completeSwap: jest.fn(async () => {
        spent = true;
        return { keep: [{ id: keyset, amount: 4, C: point(), secret: Buffer.from(output.secret).toString("utf8") }] };
      }) as never,
    };
    const mint: EscrowPayoutMintApi = {
      getKeys: jest.fn(async () => ({ keysets: [{ id: keyset, unit: "sat", keys: { "4": point() } }] })) as never,
      restore: jest.fn(async ({ outputs }: any) => ({
        outputs, signatures: outputs.map((o: any) => ({ id: o.id, amount: o.amount, C_: point() })),
      })) as never,
    };
    const run = (expired: boolean) => processEscrowOutboxEntry(id, {
      now: expired ? afterExpiry : new Date(),
      notifyPayoutFinalized: async () => false,
      executePayout: (registration, action, payload, options) =>
        executeEscrowPayout(registration, action, payload, {
          ...options, nowSeconds: expired ? expiresAt + 1 : undefined,
          walletFactory: () => wallet, mintApiFactory: () => mint,
        }),
    });
    const finalize = jest.spyOn(escrow, "finalizeEscrowOutboxEntry").mockRejectedValueOnce(new Error("controlled post-swap finalize failure"));
    expect((await run(false)).status).toBe("failed");
    finalize.mockRestore();
    expect(spent).toBe(true);
    const claim = await escrow.claimEscrowOutboxEntry(id);
    expect(claim?.preparedOutputs).toHaveLength(1);
    await expect(escrow.convertExpiredReleaseToRefund(id, claim!.claimToken, afterExpiry)).resolves.toBe(false);
    const client = await db.getDbPool().connect();
    try {
      await client.query("BEGIN");
      // The retired conversion lacked the prepared_outputs IS NULL fence.
      const old = await client.query(`UPDATE cashu_escrow_outbox o
        SET action='refund', prepared_outputs=NULL, payout_payload=NULL
        FROM cashu_escrow_registrations r
        WHERE o.outbox_id=$1 AND o.claim_token=$2 AND o.status='processing'
          AND r.escrow_id=o.escrow_id AND r.expires_at <= $3
        RETURNING o.prepared_outputs`, [id, claim!.claimToken, afterExpiry]);
      expect(old.rows).toEqual([{ prepared_outputs: null }]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    await escrow.releaseEscrowOutboxClaim(id, claim!.claimToken, "controlled retry");
    expect((await run(true)).status).toBe("processed");
    expect(wallet.completeSwap).toHaveBeenCalledTimes(1);
    expect(mint.restore).toHaveBeenCalledTimes(1);
    const result = await db.getDbPool().query(`SELECT o.status, o.payout_outputs, r.status AS registration_status
      FROM cashu_escrow_outbox o JOIN cashu_escrow_registrations r USING (escrow_id)
      WHERE o.outbox_id=$1`, [id]);
    expect(result.rows[0]).toMatchObject({ status: "done", registration_status: "released" });
    expect(result.rows[0].payout_outputs).toHaveLength(1);
  });
});
