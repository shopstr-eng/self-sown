// Concurrency/replay tests for the escrow outbox run against a small
// stateful fake pool that emulates the exact SQL semantics the service
// relies on (ON CONFLICT DO NOTHING, atomic UPDATE...WHERE status/token
// guards). Each fakeQuery call is atomic (JS single thread), which mirrors
// the per-statement atomicity Postgres gives the real queries. Real-Postgres
// isolation (row locking, FOR UPDATE serialization, deadlock behavior) is
// covered by cashu-escrow-service-db.test.ts, which runs against a live
// Postgres via RUN_TESTCONTAINERS=1 or ESCROW_CONCURRENCY_TEST_DATABASE_URL.

import type { Event } from "nostr-tools";
import {
  registerEscrowCommitment,
  enqueueEscrowAction,
  claimEscrowOutboxEntry,
  finalizeEscrowOutboxEntry,
  releaseEscrowOutboxClaim,
  recoverStaleEscrowOutboxClaims,
  listExpiredLockedEscrows,
  getEscrowRegistration,
  listPendingEscrowOutboxEntries,
  attachEscrowPayoutPayload,
  saveEscrowPreparedOutputs,
  convertExpiredReleaseToRefund,
  deriveOutboxId,
  ESCROW_CLAIM_STALE_MS,
} from "@/utils/db/cashu-escrow-service";
import type { EscrowCommitment } from "@/utils/cashu/escrow-commitment";

interface RegistrationRow {
  escrow_id: string;
  buyer_pubkey: string;
  seller_pubkey: string;
  order_id: string;
  amount_sats: number;
  mint_url: string;
  arbiter_pubkey: string | null;
  expires_at: Date;
  status: string;
}

interface OutboxRow {
  outbox_id: string;
  escrow_id: string;
  action: string;
  status: string;
  attempts: number;
  claim_token: string | null;
  claimed_at: Date | null;
  last_error: string | null;
  payout_payload: unknown | null;
  payout_outputs: unknown | null;
  prepared_outputs: unknown | null;
  updated_at: Date;
  created_seq: number;
}

const registrations = new Map<string, RegistrationRow>();
const outbox = new Map<string, OutboxRow>();
let fakeNow = new Date("2026-09-01T00:00:00Z");

function makeResult(rows: any[], rowCount?: number) {
  return { rows, rowCount: rowCount ?? rows.length };
}

async function fakeQuery(sql: string, params: any[] = []) {
  const text = sql.replace(/\s+/g, " ").trim();

  if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
    return makeResult([], 0);
  }

  if (text.startsWith("INSERT INTO cashu_escrow_registrations")) {
    const [
      escrow_id,
      buyer_pubkey,
      seller_pubkey,
      order_id,
      amount_sats,
      mint_url,
      arbiter_pubkey,
      expiresAtSeconds,
    ] = params;
    if (registrations.has(escrow_id)) return makeResult([], 0);
    registrations.set(escrow_id, {
      escrow_id,
      buyer_pubkey,
      seller_pubkey,
      order_id,
      amount_sats,
      mint_url,
      arbiter_pubkey,
      expires_at: new Date(expiresAtSeconds * 1000),
      status: "locked",
    });
    return makeResult([{ escrow_id }], 1);
  }

  if (text.startsWith("SELECT seller_pubkey, amount_sats")) {
    const row = registrations.get(params[0]);
    return makeResult(row ? [row] : []);
  }

  if (text.startsWith("SELECT status FROM cashu_escrow_registrations")) {
    const row = registrations.get(params[0]);
    return makeResult(row ? [{ status: row.status }] : []);
  }

  if (text.startsWith("INSERT INTO cashu_escrow_outbox")) {
    const [outbox_id, escrow_id, action, payout_payload] = params;
    if (outbox.has(outbox_id)) return makeResult([], 0);
    outbox.set(outbox_id, {
      outbox_id,
      escrow_id,
      action,
      status: "pending",
      attempts: 0,
      claim_token: null,
      claimed_at: null,
      last_error: null,
      // Real Postgres parses JSONB on write and returns it parsed.
      payout_payload: payout_payload ? JSON.parse(payout_payload) : null,
      payout_outputs: null,
      prepared_outputs: null,
      updated_at: new Date(fakeNow),
      created_seq: outbox.size,
    });
    return makeResult([{ outbox_id }], 1);
  }

  if (text.startsWith("UPDATE cashu_escrow_outbox SET prepared_outputs")) {
    const [outbox_id, claimToken, prepared_outputs] = params;
    const row = outbox.get(outbox_id);
    if (!row || row.status !== "processing" || row.claim_token !== claimToken) {
      return makeResult([], 0);
    }
    row.prepared_outputs = prepared_outputs
      ? JSON.parse(prepared_outputs)
      : null;
    row.updated_at = new Date(fakeNow);
    return makeResult([], 1);
  }

  if (text.startsWith("UPDATE cashu_escrow_outbox o SET action = 'refund'")) {
    const [outbox_id, claimToken, now] = params;
    const row = outbox.get(outbox_id);
    const registration = row ? registrations.get(row.escrow_id) : undefined;
    const convertible =
      row &&
      registration &&
      row.status === "processing" &&
      row.claim_token === claimToken &&
      row.action === "release" &&
      registration.status === "locked" &&
      registration.expires_at <= now;
    if (!convertible) return makeResult([], 0);
    row!.action = "refund";
    row!.status = "pending";
    row!.payout_payload = null;
    row!.prepared_outputs = null;
    row!.last_error =
      "Release window expired before payout; converted to a refund.";
    row!.updated_at = new Date(fakeNow);
    return makeResult([], 1);
  }

  if (text.startsWith("UPDATE cashu_escrow_outbox SET payout_payload")) {
    const [outbox_id, payout_payload] = params;
    const row = outbox.get(outbox_id);
    if (!row || row.status !== "pending") return makeResult([], 0);
    row.payout_payload = payout_payload ? JSON.parse(payout_payload) : null;
    return makeResult([], 1);
  }

  if (text.startsWith("SELECT action FROM cashu_escrow_outbox")) {
    const row = outbox.get(params[0]);
    return makeResult(row ? [{ action: row.action }] : []);
  }

  if (text.startsWith("UPDATE cashu_escrow_outbox SET status = 'processing'")) {
    const [outbox_id, staleBefore, now, claimToken] = params;
    const row = outbox.get(outbox_id);
    const claimable =
      row &&
      row.status !== "done" &&
      (row.status === "pending" ||
        (row.claimed_at !== null && row.claimed_at < staleBefore));
    if (!claimable) return makeResult([], 0);
    row.status = "processing";
    row.attempts += 1;
    row.claimed_at = now;
    row.claim_token = claimToken;
    row.updated_at = new Date(now);
    return makeResult([{ ...row }], 1);
  }

  if (
    text.startsWith("UPDATE cashu_escrow_outbox SET status = 'done'") &&
    text.includes("RETURNING")
  ) {
    const [outbox_id, claimToken, payout_outputs] = params;
    const row = outbox.get(outbox_id);
    if (!row || row.status !== "processing" || row.claim_token !== claimToken) {
      return makeResult([], 0);
    }
    row.status = "done";
    row.payout_outputs = payout_outputs ? JSON.parse(payout_outputs) : null;
    return makeResult([{ escrow_id: row.escrow_id, action: row.action }], 1);
  }

  if (
    text.startsWith("UPDATE cashu_escrow_outbox SET status = 'pending'") &&
    text.includes("last_error")
  ) {
    const [outbox_id, claimToken, errorMessage] = params;
    const row = outbox.get(outbox_id);
    if (row && row.status === "processing" && row.claim_token === claimToken) {
      row.status = "pending";
      row.last_error = errorMessage;
      row.updated_at = new Date(fakeNow);
      return makeResult([], 1);
    }
    return makeResult([], 0);
  }

  if (text.startsWith("UPDATE cashu_escrow_outbox SET status = 'pending'")) {
    const staleBefore = params[0];
    let recovered = 0;
    for (const row of outbox.values()) {
      if (
        row.status === "processing" &&
        row.claimed_at !== null &&
        row.claimed_at < staleBefore
      ) {
        row.status = "pending";
        row.updated_at = new Date(fakeNow);
        recovered += 1;
      }
    }
    return makeResult([], recovered);
  }

  if (text.startsWith("UPDATE cashu_escrow_registrations SET status")) {
    const [escrow_id, status] = params;
    const row = registrations.get(escrow_id);
    // Conditional transition: only a still-locked escrow may resolve.
    if (!row || row.status !== "locked") return makeResult([], 0);
    row.status = status;
    return makeResult([], 1);
  }

  if (text.startsWith("SELECT escrow_id FROM cashu_escrow_registrations")) {
    const now = params[0];
    const rows = [...registrations.values()]
      .filter((r) => r.status === "locked" && r.expires_at < now)
      .map((r) => ({ escrow_id: r.escrow_id }));
    return makeResult(rows);
  }

  if (text.startsWith("SELECT escrow_id, buyer_pubkey")) {
    const row = registrations.get(params[0]);
    return makeResult(row ? [{ ...row }] : []);
  }

  if (text.startsWith("SELECT outbox_id FROM cashu_escrow_outbox")) {
    const [limit, now] = params;
    // Emulate the exponential backoff: fresh entries (attempts = 0) are due
    // immediately; after n failed attempts the entry is due at
    // updated_at + min(2^(n-1) minutes, 6h).
    const backoffMs = (attempts: number) =>
      Math.min(Math.pow(2, Math.min(attempts - 1, 10)) * 60_000, 21_600_000);
    const rows = [...outbox.values()]
      .filter(
        (r) =>
          r.status === "pending" &&
          (r.attempts === 0 ||
            r.updated_at.getTime() + backoffMs(r.attempts) <= now.getTime())
      )
      .sort((a, b) => a.created_seq - b.created_seq)
      .slice(0, limit)
      .map((r) => ({ outbox_id: r.outbox_id }));
    return makeResult(rows);
  }

  throw new Error(`fake pool: unhandled SQL: ${text}`);
}

jest.mock("@/utils/db/db-service", () => ({
  getDbPool: () => ({
    query: (sql: string, params?: any[]) => fakeQuery(sql, params),
    connect: async () => ({
      query: (sql: string, params?: any[]) => fakeQuery(sql, params),
      release: () => {},
    }),
  }),
}));

const BUYER_PK = "a".repeat(64);

function makeCommitment(overrides: Partial<EscrowCommitment> = {}) {
  const commitment: EscrowCommitment = {
    buyerPubkey: BUYER_PK,
    sellerPubkey: "b".repeat(64),
    orderId: "order-1",
    amountSats: 5_000,
    mintUrl: "https://mint.example",
    expiresAt: Math.floor(fakeNow.getTime() / 1000) + 86_400,
    arbiterPubkey: "c".repeat(64),
    ...overrides,
  };
  const escrowId = `${commitment.buyerPubkey}:${commitment.orderId}`;
  const event = { id: "evt", pubkey: BUYER_PK } as unknown as Event;
  return { commitment, escrowId, event };
}

async function registered(overrides: Partial<EscrowCommitment> = {}) {
  const { commitment, escrowId, event } = makeCommitment(overrides);
  await registerEscrowCommitment(escrowId, commitment, event);
  return escrowId;
}

describe("cashu-escrow-service", () => {
  beforeEach(() => {
    registrations.clear();
    outbox.clear();
    fakeNow = new Date("2026-09-01T00:00:00Z");
  });

  describe("registerEscrowCommitment", () => {
    it("creates once and treats an identical replay as a no-op", async () => {
      const { commitment, escrowId, event } = makeCommitment();
      const first = await registerEscrowCommitment(escrowId, commitment, event);
      expect(first).toEqual({ created: true, escrowId });

      const replay = await registerEscrowCommitment(
        escrowId,
        commitment,
        event
      );
      expect(replay).toEqual({ created: false, escrowId });
      expect(registrations.size).toBe(1);
    });

    it("rejects a replay with different terms for the same escrow id", async () => {
      const { commitment, escrowId, event } = makeCommitment();
      await registerEscrowCommitment(escrowId, commitment, event);

      await expect(
        registerEscrowCommitment(
          escrowId,
          { ...commitment, amountSats: 1 },
          event
        )
      ).rejects.toThrow(/terms differ/);
      await expect(
        registerEscrowCommitment(
          escrowId,
          { ...commitment, sellerPubkey: "f".repeat(64) },
          event
        )
      ).rejects.toThrow(/terms differ/);
    });
  });

  describe("enqueueEscrowAction", () => {
    it("is idempotent when the same action is replayed", async () => {
      const escrowId = await registered();
      const first = await enqueueEscrowAction(escrowId, "release");
      expect(first.enqueued).toBe(true);
      const second = await enqueueEscrowAction(escrowId, "release");
      expect(second.enqueued).toBe(false);
      expect(outbox.size).toBe(1);
    });

    it("lets at most one of two racing opposite actions become payable", async () => {
      const escrowId = await registered();
      const results = await Promise.allSettled([
        enqueueEscrowAction(escrowId, "release"),
        enqueueEscrowAction(escrowId, "refund"),
      ]);
      const succeeded = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      // Exactly one action exists; the other either lost the insert race
      // outright or was rejected as the opposite action.
      expect(outbox.size).toBe(1);
      expect(succeeded.length).toBeGreaterThanOrEqual(1);
      for (const r of rejected) {
        expect((r as PromiseRejectedResult).reason.message).toMatch(
          /already has a pending/
        );
      }
    });

    it("rejects the opposite action even after the first completes", async () => {
      const escrowId = await registered();
      await enqueueEscrowAction(escrowId, "release");
      const claim = await claimEscrowOutboxEntry(deriveOutboxId(escrowId));
      await finalizeEscrowOutboxEntry(
        deriveOutboxId(escrowId),
        claim!.claimToken
      );

      await expect(enqueueEscrowAction(escrowId, "refund")).rejects.toThrow(
        /already released/
      );
    });

    it("rejects actions for unknown escrows", async () => {
      await expect(
        enqueueEscrowAction("nobody:nowhere", "refund")
      ).rejects.toThrow(/not registered/);
    });
  });

  describe("claimEscrowOutboxEntry concurrency", () => {
    it("lets exactly one of two racing workers win the claim", async () => {
      const escrowId = await registered();
      const { outboxId } = await enqueueEscrowAction(escrowId, "release");

      const [winner, loser] = await Promise.all([
        claimEscrowOutboxEntry(outboxId, { now: fakeNow }),
        claimEscrowOutboxEntry(outboxId, { now: fakeNow }),
      ]);
      const results = [winner, loser];
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(results.filter((r) => r === null)).toHaveLength(1);
      expect(winner ?? loser).toMatchObject({
        outboxId,
        escrowId,
        action: "release",
        status: "processing",
        attempts: 1,
      });
    });

    it("never reclaims a done entry", async () => {
      const escrowId = await registered();
      const { outboxId } = await enqueueEscrowAction(escrowId, "release");
      const claim = await claimEscrowOutboxEntry(outboxId, { now: fakeNow });
      await finalizeEscrowOutboxEntry(outboxId, claim!.claimToken);

      const reclaim = await claimEscrowOutboxEntry(outboxId, {
        now: new Date(fakeNow.getTime() + ESCROW_CLAIM_STALE_MS + 1000),
      });
      expect(reclaim).toBeNull();
    });
  });

  describe("crash recovery and fencing", () => {
    it("requeues a stale claim and pays out exactly once", async () => {
      const escrowId = await registered();
      const { outboxId } = await enqueueEscrowAction(escrowId, "refund");

      const claim = await claimEscrowOutboxEntry(outboxId, { now: fakeNow });
      expect(claim).not.toBeNull();
      // Simulate the worker dying: no finalize, no release.

      // A fresh claim inside the stale window must NOT steal the work.
      const oneMinuteLater = new Date(fakeNow.getTime() + 60_000);
      expect(
        await claimEscrowOutboxEntry(outboxId, { now: oneMinuteLater })
      ).toBeNull();

      // After the stale window, recovery sweeps it back to pending...
      const recovered = await recoverStaleEscrowOutboxClaims({
        staleBefore: new Date(fakeNow.getTime() + 1000),
      });
      expect(recovered).toBe(1);

      // ...and the next worker completes the payout exactly once.
      const reclaim = await claimEscrowOutboxEntry(outboxId, {
        now: new Date(fakeNow.getTime() + ESCROW_CLAIM_STALE_MS + 1000),
      });
      expect(reclaim).toMatchObject({ attempts: 2, status: "processing" });
      await finalizeEscrowOutboxEntry(outboxId, reclaim!.claimToken);
      expect(registrations.get(escrowId)?.status).toBe("refunded");
    });

    it("fences out the stale worker after its claim is reclaimed", async () => {
      const escrowId = await registered();
      const { outboxId } = await enqueueEscrowAction(escrowId, "release");

      const staleWorker = await claimEscrowOutboxEntry(outboxId, {
        now: fakeNow,
      });
      // Claim goes stale; another worker reclaims it.
      const newWorker = await claimEscrowOutboxEntry(outboxId, {
        now: new Date(fakeNow.getTime() + ESCROW_CLAIM_STALE_MS + 1000),
      });
      expect(newWorker).not.toBeNull();
      expect(newWorker!.claimToken).not.toBe(staleWorker!.claimToken);

      // The stale worker can neither finalize nor release the claim anymore.
      await expect(
        finalizeEscrowOutboxEntry(outboxId, staleWorker!.claimToken)
      ).rejects.toThrow(/not held by this worker/);
      await expect(
        releaseEscrowOutboxClaim(outboxId, staleWorker!.claimToken, "late")
      ).resolves.toBe(false);

      // The current worker completes normally.
      await finalizeEscrowOutboxEntry(outboxId, newWorker!.claimToken);
      expect(registrations.get(escrowId)?.status).toBe("released");
    });

    it("refuses to finalize twice", async () => {
      const escrowId = await registered();
      const { outboxId } = await enqueueEscrowAction(escrowId, "release");
      const claim = await claimEscrowOutboxEntry(outboxId, { now: fakeNow });
      await finalizeEscrowOutboxEntry(outboxId, claim!.claimToken);
      await expect(
        finalizeEscrowOutboxEntry(outboxId, claim!.claimToken)
      ).rejects.toThrow(/not held by this worker/);
    });

    it("returns a failed claim to pending with the error recorded", async () => {
      const escrowId = await registered();
      const { outboxId } = await enqueueEscrowAction(escrowId, "release");

      const claim = await claimEscrowOutboxEntry(outboxId, { now: fakeNow });
      const released = await releaseEscrowOutboxClaim(
        outboxId,
        claim!.claimToken,
        "mint unreachable"
      );
      expect(released).toBe(true);

      const row = outbox.get(outboxId)!;
      expect(row.status).toBe("pending");
      expect(row.last_error).toBe("mint unreachable");

      const reclaim = await claimEscrowOutboxEntry(outboxId, { now: fakeNow });
      expect(reclaim).not.toBeNull();
    });
  });

  describe("listExpiredLockedEscrows", () => {
    it("returns only locked escrows past expiry", async () => {
      const expiredId = await registered({
        orderId: "old",
        expiresAt: Math.floor(fakeNow.getTime() / 1000) - 10,
      });
      await registered({ orderId: "new" });

      const due = await listExpiredLockedEscrows(fakeNow);
      expect(due).toEqual([{ escrowId: expiredId }]);
    });
  });

  describe("payout payloads", () => {
    it("stores the payout payload at enqueue and returns it with the claim", async () => {
      const escrowId = await registered();
      const payload = { proofs: [{ secret: "s", amount: 5000 }] };
      const { outboxId } = await enqueueEscrowAction(
        escrowId,
        "release",
        payload
      );

      const claim = await claimEscrowOutboxEntry(outboxId, { now: fakeNow });
      expect(claim!.payoutPayload).toEqual(payload);
    });

    it("attachEscrowPayoutPayload fills a pending entry but not a claimed one", async () => {
      const escrowId = await registered();
      const { outboxId } = await enqueueEscrowAction(escrowId, "refund");

      const attached = await attachEscrowPayoutPayload(outboxId, {
        proofs: [{ secret: "a", amount: 1 }],
      });
      expect(attached).toBe(true);

      // A claimed (processing) entry must not have its payload swapped
      // out from under the worker that already read it.
      const claim = await claimEscrowOutboxEntry(outboxId, { now: fakeNow });
      expect(claim).not.toBeNull();
      const reattached = await attachEscrowPayoutPayload(outboxId, {
        proofs: [{ secret: "b", amount: 1 }],
      });
      expect(reattached).toBe(false);
    });

    it("finalize records the payout outputs on the row", async () => {
      const escrowId = await registered();
      const { outboxId } = await enqueueEscrowAction(escrowId, "release");
      const claim = await claimEscrowOutboxEntry(outboxId, { now: fakeNow });

      const outputs = [{ secret: "out", amount: 4999 }];
      await finalizeEscrowOutboxEntry(outboxId, claim!.claimToken, outputs);

      const row = outbox.get(outboxId)!;
      expect(row.status).toBe("done");
      expect(row.payout_outputs).toEqual(outputs);
    });
  });

  describe("getEscrowRegistration", () => {
    it("returns the registered escrow or null", async () => {
      const escrowId = await registered();
      const registration = await getEscrowRegistration(escrowId);
      expect(registration).toMatchObject({
        escrowId,
        buyerPubkey: BUYER_PK,
        sellerPubkey: "b".repeat(64),
        orderId: "order-1",
        amountSats: 5_000,
        mintUrl: "https://mint.example",
        status: "locked",
      });
      expect(registration!.expiresAt).toBeInstanceOf(Date);
      expect(await getEscrowRegistration("nobody:nowhere")).toBeNull();
    });
  });

  describe("listPendingEscrowOutboxEntries", () => {
    it("lists pending entries oldest first and honors the limit", async () => {
      const first = await registered({ orderId: "o1" });
      const second = await registered({ orderId: "o2" });
      const third = await registered({ orderId: "o3" });
      await enqueueEscrowAction(first, "refund");
      await enqueueEscrowAction(second, "release");
      await enqueueEscrowAction(third, "refund");

      // Claiming the second entry takes it out of the pending set.
      await claimEscrowOutboxEntry(deriveOutboxId(second), { now: fakeNow });

      const pending = await listPendingEscrowOutboxEntries(10, fakeNow);
      expect(pending).toEqual([
        { outboxId: deriveOutboxId(first) },
        { outboxId: deriveOutboxId(third) },
      ]);

      const limited = await listPendingEscrowOutboxEntries(1, fakeNow);
      expect(limited).toEqual([{ outboxId: deriveOutboxId(first) }]);
    });

    it("backs off failed entries exponentially instead of hot-looping", async () => {
      const escrowId = await registered({ orderId: "backoff" });
      const { outboxId } = await enqueueEscrowAction(escrowId, "release");

      // Fresh entries are due immediately.
      expect(await listPendingEscrowOutboxEntries(10, fakeNow)).toEqual([
        { outboxId },
      ]);

      // After one failed attempt the entry backs off for a minute.
      const claim = await claimEscrowOutboxEntry(outboxId, { now: fakeNow });
      await releaseEscrowOutboxClaim(outboxId, claim!.claimToken, "boom");
      expect(await listPendingEscrowOutboxEntries(10, fakeNow)).toEqual([]);
      expect(
        await listPendingEscrowOutboxEntries(
          10,
          new Date(fakeNow.getTime() + 61_000)
        )
      ).toEqual([{ outboxId }]);
    });
  });

  describe("saveEscrowPreparedOutputs", () => {
    it("is fenced by the claim token and the processing status", async () => {
      const escrowId = await registered();
      const { outboxId } = await enqueueEscrowAction(escrowId, "release");
      const claim = await claimEscrowOutboxEntry(outboxId, { now: fakeNow });

      const prepared = [{ blindedMessage: { amount: "4", id: "k", B_: "ab" } }];
      // A stale/foreign fencing token must not be able to write outputs.
      await expect(
        saveEscrowPreparedOutputs(outboxId, "wrong-token", prepared)
      ).resolves.toBe(false);
      await expect(
        saveEscrowPreparedOutputs(outboxId, claim!.claimToken, prepared)
      ).resolves.toBe(true);
      expect(outbox.get(outboxId)!.prepared_outputs).toEqual(prepared);

      // Once the claim is released the entry is no longer 'processing'.
      await releaseEscrowOutboxClaim(outboxId, claim!.claimToken, "x");
      await expect(
        saveEscrowPreparedOutputs(outboxId, claim!.claimToken, prepared)
      ).resolves.toBe(false);
    });
  });

  describe("convertExpiredReleaseToRefund", () => {
    it("converts a claimed release on an expired escrow into a pending refund", async () => {
      const escrowId = await registered({
        orderId: "expired",
        expiresAt: Math.floor(fakeNow.getTime() / 1000) - 10,
      });
      const payload = { proofs: [{ secret: "s", amount: 5000 }] };
      const { outboxId } = await enqueueEscrowAction(
        escrowId,
        "release",
        payload
      );
      const claim = await claimEscrowOutboxEntry(outboxId, { now: fakeNow });

      const converted = await convertExpiredReleaseToRefund(
        outboxId,
        claim!.claimToken,
        fakeNow
      );

      expect(converted).toBe(true);
      const row = outbox.get(outboxId)!;
      expect(row.action).toBe("refund");
      expect(row.status).toBe("pending");
      // The seller-signed release payload must not survive the conversion.
      expect(row.payout_payload).toBeNull();
      expect(row.prepared_outputs).toBeNull();
    });

    it("refuses to convert a release whose escrow has not expired", async () => {
      const escrowId = await registered({ orderId: "fresh" });
      const { outboxId } = await enqueueEscrowAction(escrowId, "release");
      const claim = await claimEscrowOutboxEntry(outboxId, { now: fakeNow });

      await expect(
        convertExpiredReleaseToRefund(outboxId, claim!.claimToken, fakeNow)
      ).resolves.toBe(false);
      expect(outbox.get(outboxId)!.action).toBe("release");
      expect(outbox.get(outboxId)!.status).toBe("processing");
    });
  });
});
