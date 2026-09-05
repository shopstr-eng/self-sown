/**
 * @jest-environment node
 */

// STAGING crash-test for the escrow payout worker — the threat model's
// enabling-checklist item (docs/cashu-escrow-threat-model.md) that must pass
// before NEXT_PUBLIC_CASHU_ESCROW_ENABLED is ever turned on:
//
//   1. Worker killed mid-release: the swap lands at the mint, then the worker
//      dies holding its claim (no catch, no release — the row stays
//      'processing'). The stale-claim sweep requeues it, a replacement worker
//      claims it with a fresh fencing token, the dead worker's token is
//      rejected by BOTH fenced writes, and the production worker path finds
//      the inputs SPENT, reconstructs the payee's proofs from the persisted
//      prepared outputs via the mint's NUT-09 /restore endpoint, and pays
//      EXACTLY once.
//   2. Expiry race: a release claimed BEFORE the lock window closes but
//      executed AFTER it must fail closed (the seller is never paid — the
//      mint shows no spend), requeue, and convert to a pending refund, which
//      then pays the buyer exactly once.
//
// Everything downstream of the crash injection is the REAL production path:
// claimEscrowOutboxEntry (including its stale-claim reclaim predicate — the
// same one recoverStaleEscrowOutboxClaims applies, exercised row-scoped so a
// shared staging DB race is impossible) / processEscrowOutboxEntry /
// executeEscrowPayout against the staging Nutshell mint (FakeWallet) and real
// Postgres. Only the payout notification is stubbed (Nostr DM is not under
// test here).
//
// GATED — skipped with a loud warning unless ALL of:
//   ESCROW_CRASH_TEST_DATABASE_URL   Postgres with the runtime schema (the
//                                    dev database works)
//   ESCROW_CRASH_TEST_DESTRUCTIVE_OK=1
//                                    explicit acknowledgement that the URL is
//                                    a NON-PRODUCTION database (the suite
//                                    deletes its test rows)
//   the staging mint answers /v1/info (start the Staging Cashu Mint workflow)
//
// Run:  ESCROW_CRASH_TEST_DATABASE_URL="$DATABASE_URL" \
//       ESCROW_CRASH_TEST_DESTRUCTIVE_OK=1 \
//       npx jest utils/cashu/__tests__/escrow-worker-crash-staging.test.ts \
//         --runInBand --no-coverage
//
// Test rows carry a per-run crash-test-<timestamp> order-id marker. Cleanup
// deletes by exact id after each test; the sweep for rows orphaned by an
// interrupted run is age-guarded (>1h old) so a concurrently running
// invocation's live rows are never touched.

import {
  Mint as CashuMint,
  Wallet as CashuWallet,
  schnorrSignMessage,
  type Proof,
} from "@cashu/cashu-ts";
import { generateSecretKey, getPublicKey } from "nostr-tools";

jest.setTimeout(300000);

type DbModule = typeof import("@/utils/db/db-service");
type EscrowModule = typeof import("@/utils/db/cashu-escrow-service");
type PayoutModule = typeof import("@/utils/cashu/escrow-payout");
type WorkerModule = typeof import("@/utils/cashu/escrow-payout-worker");
type EscrowCommitment =
  import("@/utils/cashu/escrow-commitment").EscrowCommitment;
type SerializedOutputData = import("@cashu/cashu-ts").SerializedOutputData;

const STAGING_MINT_URL =
  process.env.STAGING_CASHU_MINT_URL ?? "http://127.0.0.1:3338";
const EXTERNAL_DATABASE_URL = process.env.ESCROW_CRASH_TEST_DATABASE_URL;
const DESTRUCTIVE_OK = process.env.ESCROW_CRASH_TEST_DESTRUCTIVE_OK === "1";
const SHOULD_RUN = Boolean(EXTERNAL_DATABASE_URL) && DESTRUCTIVE_OK;
const maybeIt = SHOULD_RUN ? test : test.skip;

if (!SHOULD_RUN) {
  // eslint-disable-next-line no-console
  console.warn(
    "\n[escrow-worker-crash-staging] SKIPPED — needs BOTH " +
      "ESCROW_CRASH_TEST_DATABASE_URL (non-production Postgres) AND " +
      "ESCROW_CRASH_TEST_DESTRUCTIVE_OK=1; see the header for the run " +
      "command. This skip is intentional outside staging runs.\n"
  );
}

const ORDER_PREFIX = `crash-test-${Date.now()}`;
const ESCROW_TABLES = ["cashu_escrow_registrations", "cashu_escrow_outbox"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const probeMint = async (): Promise<boolean> => {
  try {
    const res = await fetch(`${STAGING_MINT_URL}/v1/info`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
};

/** Mints `amount` sats from the staging FakeWallet mint (auto-settles). */
const mintProofs = async (
  wallet: CashuWallet,
  amount: number
): Promise<Proof[]> => {
  const quote = await wallet.createMintQuoteBolt11(amount);
  let state: string | undefined;
  for (let i = 0; i < 40; i++) {
    const checked = await wallet.checkMintQuoteBolt11(quote.quote);
    state = typeof checked === "string" ? checked : checked?.state;
    if (state === "PAID" || state === "ISSUED") break;
    await sleep(250);
  }
  if (state !== "PAID" && state !== "ISSUED") {
    throw new Error(`Staging mint quote never settled (state=${state})`);
  }
  return wallet.mintProofsBolt11(amount, quote.quote);
};

/** Swaps fresh proofs into the exact 1-of-1 escrow lock construction. */
const lockProofsToEscrow = async (opts: {
  sellerPub: string;
  buyerPub: string;
  amount: number;
  locktime: number;
}): Promise<Proof[]> => {
  const wallet = new CashuWallet(new CashuMint(STAGING_MINT_URL));
  await wallet.loadMint();
  const funding = await mintProofs(wallet, opts.amount);
  const { send } = await wallet.send(
    opts.amount,
    funding,
    { includeFees: false },
    {
      send: {
        type: "p2pk",
        options: {
          pubkey: opts.sellerPub,
          locktime: opts.locktime,
          refundKeys: [opts.buyerPub],
          sigFlag: "SIG_INPUTS",
        },
      },
    }
  );
  // The live mint round-trips amounts as strings; the payout worker's shape
  // check requires real numbers (production clients normalize before POST —
  // do the same here). cashu-ts v4 types Proof.amount as its Amount value
  // object, but on the wire (and in every payload the worker validates) it
  // is a plain number — normalize, then cast through the wire shape.
  return send.map((p) => ({
    ...p,
    amount: Number(p.amount),
  })) as unknown as Proof[];
};

/** Attaches a P2PK witness signature from the given key (real schnorr). */
const witness = (proof: Proof, priv: string): Proof => ({
  ...proof,
  witness: JSON.stringify({
    signatures: [schnorrSignMessage(proof.secret, priv)],
  }),
});

describe("escrow payout worker — staging crash recovery", () => {
  let db: DbModule;
  let escrow: EscrowModule;
  let payout: PayoutModule;
  let worker: WorkerModule;
  let mintAvailable = false;
  let previousDatabaseUrl: string | undefined;
  let createdEscrowIds: string[] = [];
  let allCreatedEscrowIds: string[] = [];

  /** Exact-id delete (per-test rows), or an AGE-GUARDED orphan sweep. */
  const cleanupTestEscrows = async (
    ids: string[],
    orphanedSweep: boolean
  ): Promise<void> => {
    const pool = db.getDbPool();
    if (orphanedSweep) {
      // Only rows older than 1h: a concurrently running invocation's live
      // rows must never be touched.
      await pool.query(
        `DELETE FROM cashu_escrow_outbox
         WHERE escrow_id LIKE '%:crash-test-%'
           AND created_at < NOW() - INTERVAL '1 hour'`
      );
      await pool.query(
        `DELETE FROM cashu_escrow_registrations
         WHERE escrow_id LIKE '%:crash-test-%'
           AND created_at < NOW() - INTERVAL '1 hour'`
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
  };

  const waitForTables = async (tableNames: string[]): Promise<void> => {
    const deadline = Date.now() + 60000;
    const pool = db.getDbPool();
    while (Date.now() < deadline) {
      const client = await pool.connect();
      try {
        const result = await client.query<{ tablename: string }>(
          `SELECT tablename FROM pg_tables
           WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
          [tableNames]
        );
        if (result.rows.length === tableNames.length) return;
      } finally {
        client.release();
      }
      await sleep(100);
    }
    throw new Error(`Timed out waiting for tables: ${tableNames.join(", ")}`);
  };

  beforeAll(async () => {
    if (!SHOULD_RUN) return;
    mintAvailable = await probeMint();
    if (!mintAvailable) {
      console.warn(
        `[escrow-worker-crash-staging] staging mint unreachable at ${STAGING_MINT_URL}; ` +
          "skipping (start the Staging Cashu Mint workflow to run these)"
      );
      return;
    }
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = EXTERNAL_DATABASE_URL!;
    // One isolated module context so every service shares a single pool.
    await jest.isolateModulesAsync(async () => {
      jest.resetModules();
      jest.unmock("pg");
      db = await import("@/utils/db/db-service");
      escrow = await import("@/utils/db/cashu-escrow-service");
      payout = await import("@/utils/cashu/escrow-payout");
      worker = await import("@/utils/cashu/escrow-payout-worker");
    });
    await waitForTables(ESCROW_TABLES);
    // Sweep rows orphaned by an interrupted previous run (age-guarded).
    await cleanupTestEscrows([], true);
  }, 300000);

  afterAll(async () => {
    if (!SHOULD_RUN || !mintAvailable) return;
    try {
      await cleanupTestEscrows(allCreatedEscrowIds, false);
      await db.closeDbPool();
    } finally {
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
    if (!SHOULD_RUN || !mintAvailable || createdEscrowIds.length === 0) return;
    await cleanupTestEscrows(createdEscrowIds, false);
  });

  /** Registers + enqueues + attaches a ready release payload. */
  const setupLockedEscrow = async (suffix: string, lockSeconds: number) => {
    const buyerSecret = generateSecretKey();
    const sellerSecret = generateSecretKey();
    const buyerPub = getPublicKey(buyerSecret);
    const sellerPub = getPublicKey(sellerSecret);
    const buyerPriv = Buffer.from(buyerSecret).toString("hex");
    const sellerPriv = Buffer.from(sellerSecret).toString("hex");
    const orderId = `${ORDER_PREFIX}-${suffix}`;
    const escrowId = `${buyerPub}:${orderId}`;
    createdEscrowIds.push(escrowId);
    allCreatedEscrowIds.push(escrowId);
    const locktime = Math.floor(Date.now() / 1000) + lockSeconds;
    const amount = 8;

    const locked = await lockProofsToEscrow({
      sellerPub,
      buyerPub,
      amount,
      locktime,
    });
    const commitment: EscrowCommitment = {
      buyerPubkey: buyerPub,
      sellerPubkey: sellerPub,
      orderId,
      amountSats: amount,
      mintUrl: STAGING_MINT_URL,
      expiresAt: locktime,
    };
    await escrow.registerEscrowCommitment(escrowId, commitment, {
      id: "0".repeat(64),
      pubkey: buyerPub,
    } as unknown as import("nostr-tools").Event);
    const { outboxId } = await escrow.enqueueEscrowAction(escrowId, "release");
    const attached = await escrow.attachEscrowPayoutPayload(outboxId, {
      proofs: locked.map((p) => witness(p, sellerPriv)),
      stage: "ready",
    });
    expect(attached).toBe(true);
    return {
      escrowId,
      outboxId,
      locktime,
      locked,
      buyerPriv,
      sellerPriv,
      sellerPub,
      buyerPub,
    };
  };

  const noopNotify = async () => true;

  const stateWallet = async (): Promise<CashuWallet> => {
    const wallet = new CashuWallet(new CashuMint(STAGING_MINT_URL));
    await wallet.loadMint();
    return wallet;
  };

  maybeIt(
    "recovers a worker killed mid-release (claim retained) — stale sweep, fencing, /restore, exactly once",
    async () => {
      if (!mintAvailable) return;
      const { escrowId, outboxId, locked, sellerPub } = await setupLockedEscrow(
        "release",
        3600
      );
      const registration = await escrow.getEscrowRegistration(escrowId);
      expect(registration).not.toBeNull();

      // ── Worker run #1: claim, perform the REAL mint swap (prepared
      // payee-locked outputs persisted under the claim token, exactly as the
      // worker does), then DIE — no finalize, no release. The row stays
      // 'processing' with this claim token, as after a real process kill.
      const claimA = await escrow.claimEscrowOutboxEntry(outboxId);
      expect(claimA).not.toBeNull();
      const swapResult = await payout.executeEscrowPayout(
        registration!,
        "release",
        claimA!.payoutPayload,
        {
          nowSeconds: Math.floor(Date.now() / 1000),
          preparedOutputs:
            (claimA!.preparedOutputs as SerializedOutputData[] | null) ??
            undefined,
          persistPreparedOutputs: async (prepared) => {
            const saved = await escrow.saveEscrowPreparedOutputs(
              outboxId,
              claimA!.claimToken,
              prepared
            );
            if (!saved) {
              throw new Error(
                "Claim lost before prepared payout outputs could be recorded"
              );
            }
          },
        }
      );
      expect(swapResult.outputs.length).toBeGreaterThan(0);

      // The swap really happened: every locked input is SPENT at the mint.
      // (If this fails, nothing below proves recovery.)
      const walletA = await stateWallet();
      const inputStates = await walletA.checkProofsStates(locked);
      expect(inputStates.every((s) => s.state === "SPENT")).toBe(true);
      let outbox = await escrow.getEscrowOutboxEntryByEscrowId(escrowId);
      expect(outbox!.status).toBe("processing"); // dead worker never released

      // ── Crash-recovery reclaim: a replacement worker reclaims the dead
      // claim via the SAME stale-claim predicate the sweeper applies, but
      // row-scoped — a forced global recoverStaleEscrowOutboxClaims on a
      // shared staging DB has a check-then-act race against unrelated
      // workers (guard-then-UPDATE), so this test exercises the reclaim
      // predicate per-row instead. The requeue is what matters: the row
      // becomes claimable again with a FRESH fencing token.
      const claimB = await escrow.claimEscrowOutboxEntry(outboxId, {
        staleBefore: new Date(Date.now() + 60000),
      });
      expect(claimB).not.toBeNull();
      expect(claimB!.claimToken).not.toBe(claimA!.claimToken);

      // ── …and the dead worker's token is rejected by BOTH fenced writes
      // while the replacement claim is held.
      await expect(
        escrow.finalizeEscrowOutboxEntry(
          outboxId,
          claimA!.claimToken,
          swapResult.outputs
        )
      ).rejects.toThrow(/not held/);
      await expect(
        escrow.saveEscrowPreparedOutputs(outboxId, claimA!.claimToken, [])
      ).resolves.toBe(false);

      // ── Hand the row back to the production worker path: it finds the
      // inputs SPENT plus the persisted prepared outputs, reconstructs the
      // payee's proofs via NUT-09 /restore, and finalizes.
      await escrow.releaseEscrowOutboxClaim(
        outboxId,
        claimB!.claimToken,
        "handoff to production path"
      );
      const restarted = await worker.processEscrowOutboxEntry(outboxId, {
        notifyPayoutFinalized: noopNotify,
      });
      expect(
        restarted.status + " " + ("error" in restarted ? restarted.error : "")
      ).toBe("processed ");

      outbox = await escrow.getEscrowOutboxEntryByEscrowId(escrowId);
      expect(outbox!.status).toBe("done");
      expect(outbox!.action).toBe("release");
      const outputs = outbox!.payoutOutputs as Proof[];
      expect(Array.isArray(outputs) && outputs.length > 0).toBe(true);
      // Payee-locked to the seller, and live at the mint (real proofs).
      for (const output of outputs) {
        const secret = JSON.parse(output.secret);
        expect(secret[0]).toBe("P2PK");
        // Mints emit the P2PK lock data compressed (02 + x-only).
        expect(payout.normalizeP2PKPubkey(secret[1].data)).toBe(sellerPub);
      }
      const outputStates = await walletA.checkProofsStates(outputs);
      expect(outputStates.every((s) => s.state === "UNSPENT")).toBe(true);

      // Exactly once: a later sweep cannot re-enter the terminal row, and a
      // duplicate finalize is refused.
      const again = await worker.processEscrowOutboxEntry(outboxId, {
        notifyPayoutFinalized: noopNotify,
      });
      expect(again.status).toBe("skipped");
      await expect(
        escrow.finalizeEscrowOutboxEntry(outboxId, claimA!.claimToken, [])
      ).rejects.toThrow();
      const finalRegistration = await escrow.getEscrowRegistration(escrowId);
      expect(finalRegistration?.status).toBe("released");
    }
  );

  maybeIt(
    "fail-closes a release that crosses expiry mid-flight, converts it, refunds the buyer once",
    async () => {
      if (!mintAvailable) return;
      const LOCK_SECONDS = 15;
      const { escrowId, outboxId, locktime, locked, buyerPriv, buyerPub } =
        await setupLockedEscrow("expiry", LOCK_SECONDS);

      // The claim must land comfortably BEFORE expiry or the scenario isn't
      // actually racing the window — fail loudly here when staging was slow
      // (mint setup latency) instead of silently degrading the race.
      expect(Date.now()).toBeLessThan(locktime * 1000 - 2000);

      // ── The worker claims the release BEFORE expiry (no conversion at
      // claim time), then the executor runs PAST the lock window. The payout
      // must be refused — by the validator or by the mint itself — and the
      // seller must NOT be paid.
      const raced = await worker.processEscrowOutboxEntry(outboxId, {
        executePayout: async (registration, action, payload, options) => {
          const waitMs = locktime * 1000 + 3000 - Date.now();
          if (waitMs > 0) await sleep(waitMs);
          return payout.executeEscrowPayout(
            registration,
            action,
            payload,
            options
          );
        },
        notifyPayoutFinalized: noopNotify,
      });
      expect(raced.status).toBe("failed");

      // Fail-closed: no spend reached the mint.
      const walletB = await stateWallet();
      const inputStates = await walletB.checkProofsStates(locked);
      expect(inputStates.every((s) => s.state === "UNSPENT")).toBe(true);
      let outbox = await escrow.getEscrowOutboxEntryByEscrowId(escrowId);
      expect(outbox!.status).toBe("pending"); // released for retry by the catch

      // ── Next sweep: claimed after expiry → converted to a pending refund
      // (payload cleared — the buyer's refund proofs are required).
      const converted = await worker.processEscrowOutboxEntry(outboxId, {
        notifyPayoutFinalized: noopNotify,
      });
      expect(
        converted.status + " " + ("error" in converted ? converted.error : "")
      ).toBe("converted ");
      outbox = await escrow.getEscrowOutboxEntryByEscrowId(escrowId);
      expect(outbox!.action).toBe("refund");
      expect(outbox!.status).toBe("pending");

      // ── The buyer attaches refund-witnessed proofs; the worker pays them.
      const attached = await escrow.attachEscrowPayoutPayload(outboxId, {
        proofs: locked.map((p) => witness(p, buyerPriv)),
        stage: "ready",
      });
      expect(attached).toBe(true);

      const paid = await worker.processEscrowOutboxEntry(outboxId, {
        notifyPayoutFinalized: noopNotify,
      });
      expect(paid.status + " " + ("error" in paid ? paid.error : "")).toBe(
        "processed "
      );

      outbox = await escrow.getEscrowOutboxEntryByEscrowId(escrowId);
      expect(outbox!.status).toBe("done");
      expect(outbox!.action).toBe("refund");
      const outputs = outbox!.payoutOutputs as Proof[];
      expect(Array.isArray(outputs) && outputs.length > 0).toBe(true);
      for (const output of outputs) {
        const secret = JSON.parse(output.secret);
        expect(secret[0]).toBe("P2PK");
        expect(payout.normalizeP2PKPubkey(secret[1].data)).toBe(buyerPub);
      }
      const spentInputs = await walletB.checkProofsStates(locked);
      expect(spentInputs.every((s) => s.state === "SPENT")).toBe(true);
      const liveOutputs = await walletB.checkProofsStates(outputs);
      expect(liveOutputs.every((s) => s.state === "UNSPENT")).toBe(true);

      const again = await worker.processEscrowOutboxEntry(outboxId, {
        notifyPayoutFinalized: noopNotify,
      });
      expect(again.status).toBe("skipped");
      const registration = await escrow.getEscrowRegistration(escrowId);
      expect(registration?.status).toBe("refunded");
    }
  );
});
