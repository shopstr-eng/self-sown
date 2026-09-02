// POST /api/cashu/escrow/refund
//
// The buyer's post-expiry refund trigger. Accepts a buyer-signed escrow
// action event (kind 31996, see utils/cashu/escrow-commitment.ts) together
// with the buyer-RETAINED locked proofs carrying the buyer's P2PK witness.
// The endpoint confirms the signer is the committed buyer, that the lock has
// actually expired, and that the proofs match the registered commitment
// exactly (validateEscrowPayoutProofs — the same validator the payout worker
// runs), then enqueues the refund on the one-row-per-escrow outbox and
// attaches the signed payload atomically, so a 200 means the refund can
// actually complete. A conflicting pending release is a 409, never a silent
// flip — except one still awaiting the seller's witness, which became
// unpayable at expiry and is atomically converted to this refund instead
// (seller inaction can never block the buyer past the lock date).

import type { NextApiRequest, NextApiResponse } from "next";
import type { Event } from "nostr-tools";
import { getEncodedToken, type Proof } from "@cashu/cashu-ts";
import { applyRateLimit } from "@/utils/rate-limit";
import { isEscrowEnabled } from "@/utils/cashu/escrow-config";
import { verifyEscrowActionEvent } from "@/utils/cashu/escrow-commitment";
import { validateEscrowPayoutProofs } from "@/utils/cashu/escrow-payout";
import {
  attachEscrowPayoutPayload,
  convertExpiredAwaitingWitnessReleaseToRefund,
  enqueueEscrowAction,
  getEscrowOutboxEntryByEscrowId,
  getEscrowRegistration,
} from "@/utils/db/cashu-escrow-service";

function refundPayoutToken(
  mintUrl: string,
  payoutOutputs: unknown
): string | undefined {
  if (!Array.isArray(payoutOutputs) || payoutOutputs.length === 0) {
    return undefined;
  }
  try {
    // The outputs are P2PK-locked to the buyer, so sharing them with the
    // party who knows the escrow id is safe.
    return getEncodedToken({ mint: mintUrl, proofs: payoutOutputs as Proof[] });
  } catch {
    return undefined;
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Fail closed: escrow is inert until explicitly enabled and configured.
  if (!isEscrowEnabled()) {
    return res.status(403).json({
      error: "Cashu escrow is not enabled on this server.",
      code: "escrow_disabled",
    });
  }

  const allowed = await applyRateLimit(req, res, "cashu-escrow-refund", {
    limit: 10,
    windowMs: 60_000,
  });
  if (!allowed) return;

  const actionEvent = req.body?.actionEvent as Event | undefined;
  const payoutProofs = req.body?.payoutProofs as Proof[] | undefined;
  if (
    !actionEvent ||
    typeof actionEvent !== "object" ||
    typeof actionEvent.content !== "string" ||
    !Array.isArray(actionEvent.tags)
  ) {
    return res.status(400).json({
      error: "A signed escrow action event is required.",
      code: "invalid_request",
    });
  }
  if (!Array.isArray(payoutProofs) || payoutProofs.length === 0) {
    return res.status(400).json({
      error:
        "The buyer-signed locked proofs are required so the refund can actually be paid out.",
      code: "invalid_request",
    });
  }

  const verification = verifyEscrowActionEvent(actionEvent);
  if (!verification.ok) {
    return res
      .status(400)
      .json({ error: verification.error, code: "invalid_action" });
  }

  try {
    const registration = await getEscrowRegistration(verification.escrowId);
    if (!registration) {
      return res
        .status(404)
        .json({ error: "Escrow not found.", code: "escrow_not_found" });
    }
    // DB is authoritative on who the buyer is, even though the verifier
    // already binds the signer to the escrow id's buyer prefix.
    if (registration.buyerPubkey !== verification.actorPubkey) {
      return res.status(403).json({
        error: "Only the escrow buyer can request a refund.",
        code: "not_buyer",
      });
    }
    const expiresAtSeconds = Math.floor(
      registration.expiresAt.getTime() / 1000
    );
    if (expiresAtSeconds > Math.floor(Date.now() / 1000)) {
      return res.status(409).json({
        error: "Escrow has not expired yet; the seller can still be paid.",
        code: "not_expired",
        expiresAt: expiresAtSeconds,
      });
    }

    // The proofs must be locked EXACTLY as committed (seller lock, locktime =
    // expiry, refund = buyer, SIG_INPUTS) and carry the buyer's witness.
    try {
      validateEscrowPayoutProofs(registration, "refund", payoutProofs);
    } catch (error) {
      return res.status(400).json({
        error:
          error instanceof Error
            ? error.message
            : "Refund proofs failed validation.",
        code: "invalid_proofs",
      });
    }

    // An ignored buyer-approved release (still awaiting the seller's
    // witness) must never block the refund past expiry: atomically convert
    // it to a payload-less pending refund first (self-guarding on expired +
    // pending + awaiting-witness, so a no-op in every other state).
    await convertExpiredAwaitingWitnessReleaseToRefund(verification.escrowId);

    // Enqueued only after every skip/early-return above: the one-row outbox
    // makes the buyer's trigger idempotent and a replay harmless.
    const { enqueued } = await enqueueEscrowAction(
      verification.escrowId,
      "refund"
    );

    const outbox = await getEscrowOutboxEntryByEscrowId(verification.escrowId);
    if (!outbox) {
      throw new Error("Escrow outbox entry missing after enqueue.");
    }
    if (outbox.status === "done") {
      // Replay after completion: hand the buyer's payout back again.
      return res.status(200).json({
        escrowId: verification.escrowId,
        status: "refunded",
        enqueued: false,
        payoutToken: refundPayoutToken(
          registration.mintUrl,
          outbox.payoutOutputs
        ),
      });
    }
    if (outbox.status === "pending") {
      // Atomic against concurrent worker claims (status guard in SQL).
      let attached = await attachEscrowPayoutPayload(outbox.outboxId, {
        proofs: payoutProofs,
      });
      if (!attached) {
        // Lost a claim race with the worker between our read and the attach.
        // The worker either claimed WITH a payload (the refund will complete)
        // or fails for lack of one and returns the entry to pending — re-read
        // once and retry the attach before giving up.
        const again = await getEscrowOutboxEntryByEscrowId(
          verification.escrowId
        );
        if (again && again.status === "pending") {
          attached = await attachEscrowPayoutPayload(again.outboxId, {
            proofs: payoutProofs,
          });
        }
      }
      if (attached) {
        // Success is only reported once the payload really landed.
        return res.status(200).json({
          escrowId: verification.escrowId,
          status: "refund_pending",
          enqueued,
          attached: true,
        });
      }
    }
    // The entry is claimed by the worker (with or without a payload). Not an
    // error: the status endpoint reports payloadAttached, so the buyer UI
    // keeps the "Complete refund" control available while the payload is
    // still missing (e.g. a payload-less entry the expiry sweep enqueued).
    return res.status(200).json({
      escrowId: verification.escrowId,
      status: "refund_processing",
      enqueued,
      attached: false,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Escrow refund failed.";
    // A pending/completed release (or completed refund) is a client-visible
    // conflict, not a server fault.
    if (message.includes("already")) {
      return res.status(409).json({ error: message, code: "escrow_conflict" });
    }
    console.error("Cashu escrow refund failed:", error);
    return res
      .status(500)
      .json({ error: "Escrow refund failed.", code: "internal_error" });
  }
}
