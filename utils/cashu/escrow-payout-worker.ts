// Escrow payout worker: drains cashu_escrow_outbox so locked buyer funds can
// actually be released or refunded.
//
// Per sweep (runEscrowPayoutSweep, invoked by /api/cashu/escrow/process):
//   1. recoverStaleEscrowOutboxClaims — crash recovery: claims older than
//      ESCROW_CLAIM_STALE_MS return to pending.
//   2. listExpiredLockedEscrows → enqueueEscrowAction(escrowId, "refund") —
//      expired locks automatically get a refund entry (idempotent; the
//      one-row outbox rejects a refund when a release already exists).
//   3. Drain pending entries: claim (fencing token) → execute the P2PK
//      payout at the mint (utils/cashu/escrow-payout.ts, which re-verifies
//      proof state at the mint before EVERY attempt) → finalize with the
//      claim token. Any failure calls releaseEscrowOutboxClaim so the entry
//      is retried later instead of stranding.
//
// The whole worker fails closed: unless escrow is explicitly enabled and
// configured (utils/cashu/escrow-config.ts), a sweep is a no-op.

import { isEscrowEnabled } from "@/utils/cashu/escrow-config";
import {
  claimEscrowOutboxEntry,
  convertExpiredReleaseToRefund,
  enqueueEscrowAction,
  finalizeEscrowOutboxEntry,
  getEscrowRegistration,
  convertExpiredAwaitingWitnessReleaseToRefund,
  listExpiredLockedEscrows,
  listPendingEscrowOutboxEntries,
  recoverStaleEscrowOutboxClaims,
  releaseEscrowOutboxClaim,
  saveEscrowPreparedOutputs,
} from "@/utils/db/cashu-escrow-service";
import { executeEscrowPayout } from "@/utils/cashu/escrow-payout";
import { notifyEscrowPayoutFinalized } from "@/utils/cashu/escrow-payout-notify";
import type { SerializedOutputData } from "@cashu/cashu-ts";

export const ESCROW_PAYOUT_BATCH_SIZE = 10;

export interface EscrowPayoutWorkerDeps {
  /** Injectable for tests; defaults to the real mint payout. */
  executePayout?: typeof executeEscrowPayout;
  /** Injectable for tests; defaults to a Nostr DM to the payee. */
  notifyPayoutFinalized?: typeof notifyEscrowPayoutFinalized;
  /** Injectable clock; defaults to wall time. */
  now?: Date;
}

export type EscrowProcessResult =
  | { outboxId: string; status: "processed" }
  /** Release claimed after its lock expired — atomically became a refund. */
  | { outboxId: string; status: "converted" }
  | { outboxId: string; status: "skipped" }
  | { outboxId: string; status: "failed"; error: string };

/**
 * Claim and pay out a single outbox entry. Never throws for payout-level
 * failures — they are recorded on the row via releaseEscrowOutboxClaim and
 * retried by a later sweep. Claim-held-by-another-worker is a "skipped",
 * not a failure.
 */
export async function processEscrowOutboxEntry(
  outboxId: string,
  deps: EscrowPayoutWorkerDeps = {}
): Promise<EscrowProcessResult> {
  const payout = deps.executePayout ?? executeEscrowPayout;
  const claim = await claimEscrowOutboxEntry(outboxId);
  if (!claim) {
    return { outboxId, status: "skipped" };
  }
  try {
    const registration = await getEscrowRegistration(claim.escrowId);
    if (!registration) {
      throw new Error("Escrow registration is missing.");
    }
    if (registration.status !== "locked") {
      throw new Error(
        `Escrow is already ${registration.status}; refusing to pay out.`
      );
    }
    const now = deps.now ?? new Date();
    // Expiry race (threat model): a release claimed just before expiry but
    // executed after it must not pay the seller, and — because the outbox
    // holds one row per escrow — must not permanently block the buyer's
    // refund either. Convert it atomically (fenced by the claim token and
    // conditional on actual expiry); the buyer's signed refund proofs are
    // attached later via attachEscrowPayoutPayload.
    if (
      claim.action === "release" &&
      now.getTime() >= registration.expiresAt.getTime()
    ) {
      const converted = await convertExpiredReleaseToRefund(
        outboxId,
        claim.claimToken,
        now
      );
      if (!converted) {
        console.error(
          `[escrow-worker] claim for ${outboxId} was reclaimed during expiry conversion`
        );
        return { outboxId, status: "skipped" };
      }
      return { outboxId, status: "converted" };
    }
    const result = await payout(
      registration,
      claim.action,
      claim.payoutPayload,
      {
        // Deliberately NO nowSeconds here: the executor must judge expiry
        // with fresh time at validation, not the claim-time `now` above —
        // otherwise a release claimed just before the lock window closes but
        // executed after it would validate against a stale timestamp and pay
        // the seller post-expiry (found by the staging crash-test; the
        // staging Nutshell mint accepts data-key spends post-locktime, so
        // the executor check is the ONLY enforcement of this rule).
        preparedOutputs:
          (claim.preparedOutputs as SerializedOutputData[] | null) ?? undefined,
        // Durability hook (required by the executor): the payee-locked swap
        // outputs must be recorded BEFORE the mint call, fenced by the claim
        // token so a worker that lost its claim cannot proceed to pay.
        persistPreparedOutputs: async (prepared) => {
          const saved = await saveEscrowPreparedOutputs(
            outboxId,
            claim.claimToken,
            prepared
          );
          if (!saved) {
            throw new Error(
              "Claim lost before prepared payout outputs could be recorded; aborting payment."
            );
          }
        },
      }
    );
    await finalizeEscrowOutboxEntry(outboxId, claim.claimToken, result.outputs);
    // Post-finalize notification (exactly-once): the entry is now terminal
    // ('done'), so no later sweep re-enters this branch. The DM is
    // best-effort and isolated — a notification failure must never mark the
    // finalized payout failed or re-queue it.
    const notify = deps.notifyPayoutFinalized ?? notifyEscrowPayoutFinalized;
    try {
      await notify(registration, claim.action);
    } catch (notifyError) {
      console.error(
        `[escrow-worker] payout notification for ${outboxId} failed:`,
        notifyError instanceof Error ? notifyError.message : notifyError
      );
    }
    return { outboxId, status: "processed" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Return the entry to pending so a later sweep retries it. If the claim
    // is no longer ours (went stale and was reclaimed), the fencing token
    // simply doesn't match and the release is a no-op — the new owner owns
    // the outcome.
    const released = await releaseEscrowOutboxClaim(
      outboxId,
      claim.claimToken,
      message
    );
    if (!released) {
      console.error(
        `[escrow-worker] claim for ${outboxId} was reclaimed before failure could be recorded`
      );
    }
    return { outboxId, status: "failed", error: message };
  }
}

export interface EscrowSweepSummary {
  skipped: boolean;
  recovered: number;
  expiredFound: number;
  refundsEnqueued: number;
  processed: number;
  failed: Array<{ outboxId: string; error: string }>;
}

export async function runEscrowPayoutSweep(options?: {
  batchSize?: number;
  now?: Date;
  executePayout?: typeof executeEscrowPayout;
  notifyPayoutFinalized?: typeof notifyEscrowPayoutFinalized;
}): Promise<EscrowSweepSummary> {
  const summary: EscrowSweepSummary = {
    skipped: false,
    recovered: 0,
    expiredFound: 0,
    refundsEnqueued: 0,
    processed: 0,
    failed: [],
  };

  // Fail closed: no sweeps unless the operator enabled AND configured escrow.
  if (!isEscrowEnabled()) {
    summary.skipped = true;
    return summary;
  }

  const now = options?.now ?? new Date();

  // 1. Crash recovery first so reclaimed entries become drainable.
  summary.recovered = await recoverStaleEscrowOutboxClaims();

  // 2. Expired locks automatically get a refund enqueued. Each escrow is
  //    isolated so one bad row can't block the rest of the sweep.
  const expired = await listExpiredLockedEscrows(now);
  summary.expiredFound = expired.length;
  for (const { escrowId } of expired) {
    try {
      // An ignored buyer-approved release (still awaiting the seller's
      // witness) must not deadlock the refund past expiry: convert it to a
      // payload-less pending refund first (self-guarding, atomic). A
      // seller-COMPLETED release is untouched — the drain step converts it
      // via convertExpiredReleaseToRefund when its payout re-checks expiry.
      await convertExpiredAwaitingWitnessReleaseToRefund(escrowId);
      const result = await enqueueEscrowAction(escrowId, "refund");
      if (result.enqueued) summary.refundsEnqueued++;
    } catch (error) {
      // Expected when a release is already pending for this escrow — the
      // one-row outbox state machine guards that race. Log and move on.
      console.error(
        `[escrow-worker] could not enqueue refund for expired escrow ${escrowId}:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  // 3. Drain pending entries, oldest first. Each entry is isolated so one
  //    failure can't block the rest of the batch.
  const pending = await listPendingEscrowOutboxEntries(
    options?.batchSize ?? ESCROW_PAYOUT_BATCH_SIZE,
    now
  );
  for (const { outboxId } of pending) {
    try {
      const result = await processEscrowOutboxEntry(outboxId, {
        executePayout: options?.executePayout,
        notifyPayoutFinalized: options?.notifyPayoutFinalized,
        now,
      });
      if (result.status === "processed") summary.processed++;
      if (result.status === "failed") {
        summary.failed.push({ outboxId, error: result.error });
      }
    } catch (error) {
      summary.failed.push({
        outboxId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return summary;
}
