// POST /api/cashu/escrow/release
//
// The seller's release completion. Accepts a seller-signed escrow action
// event (kind 31996, action "release") together with the locked proofs
// carrying the seller's P2PK witness (the seller witnesses the raw proofs
// the buyer deposited via release-approve — only the seller's key can
// witness them before expiry). The endpoint confirms the signer is the
// committed seller and validates the proofs against the registered
// commitment with the payout worker's own validator (which also rejects
// post-expiry releases), then enqueues the release on the
// one-row-per-escrow outbox and attaches the payload at stage "ready"
// atomically, so a 200 means the release can actually complete. A
// conflicting pending refund is a 409, never a silent flip.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Event } from "nostr-tools";
import { getEncodedToken, type Proof } from "@cashu/cashu-ts";
import { applyRateLimit } from "@/utils/rate-limit";
import { isEscrowEnabled } from "@/utils/cashu/escrow-config";
import { verifyEscrowActionEvent } from "@/utils/cashu/escrow-commitment";
import { validateEscrowPayoutProofs } from "@/utils/cashu/escrow-payout";
import {
  attachEscrowPayoutPayload,
  enqueueEscrowAction,
  getEscrowOutboxEntryByEscrowId,
  getEscrowRegistration,
} from "@/utils/db/cashu-escrow-service";

function payoutToken(
  mintUrl: string,
  payoutOutputs: unknown
): string | undefined {
  if (!Array.isArray(payoutOutputs) || payoutOutputs.length === 0) {
    return undefined;
  }
  try {
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

  const allowed = await applyRateLimit(req, res, "cashu-escrow-release", {
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
        "The seller-witnessed locked proofs are required so the release can actually be paid out.",
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
    // DB is authoritative on who the seller is.
    if (registration.sellerPubkey !== verification.actorPubkey) {
      return res.status(403).json({
        error: "Only the escrow seller can complete a release.",
        code: "not_seller",
      });
    }

    // Full validation (the payout worker's own checks): proofs locked
    // exactly as committed, the lock still within its window (a release can
    // never pay out post-expiry), and every proof carrying the seller's
    // witness.
    try {
      validateEscrowPayoutProofs(registration, "release", payoutProofs);
    } catch (error) {
      return res.status(400).json({
        error:
          error instanceof Error
            ? error.message
            : "Release proofs failed validation.",
        code: "invalid_proofs",
      });
    }

    // Enqueued only after every skip/early-return above: the one-row outbox
    // makes the seller's submission idempotent and a replay harmless.
    const { enqueued } = await enqueueEscrowAction(
      verification.escrowId,
      "release"
    );

    const outbox = await getEscrowOutboxEntryByEscrowId(verification.escrowId);
    if (!outbox) {
      throw new Error("Escrow outbox entry missing after enqueue.");
    }
    if (outbox.status === "done") {
      // Replay after completion: hand the seller's payout back again.
      return res.status(200).json({
        escrowId: verification.escrowId,
        status: "released",
        enqueued: false,
        payoutToken: payoutToken(registration.mintUrl, outbox.payoutOutputs),
      });
    }
    if (outbox.status === "pending") {
      // Atomic against concurrent worker claims (status guard in SQL). The
      // "ready" stage makes the entry claimable by the payout worker (the
      // claim guard skips "awaiting_seller_witness" payloads).
      let attached = await attachEscrowPayoutPayload(outbox.outboxId, {
        proofs: payoutProofs,
        stage: "ready",
      });
      if (!attached) {
        // Lost a claim race with the worker between our read and the attach —
        // re-read once and retry before giving up (same pattern as refund).
        const again = await getEscrowOutboxEntryByEscrowId(
          verification.escrowId
        );
        if (again && again.status === "pending") {
          attached = await attachEscrowPayoutPayload(again.outboxId, {
            proofs: payoutProofs,
            stage: "ready",
          });
        }
      }
      if (attached) {
        // Success is only reported once the payload really landed.
        return res.status(200).json({
          escrowId: verification.escrowId,
          status: "release_pending",
          enqueued,
          attached: true,
        });
      }
    }
    return res.status(200).json({
      escrowId: verification.escrowId,
      status: "release_processing",
      enqueued,
      attached: false,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Escrow release failed.";
    // A pending/completed refund (or completed release) is a client-visible
    // conflict, not a server fault.
    if (message.includes("already")) {
      return res.status(409).json({ error: message, code: "escrow_conflict" });
    }
    console.error("Cashu escrow release failed:", error);
    return res
      .status(500)
      .json({ error: "Escrow release failed.", code: "internal_error" });
  }
}
