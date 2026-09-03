// POST /api/cashu/escrow/release-approve
//
// The buyer's EARLY release approval. Accepts a buyer-signed escrow action
// event (kind 31996, action "release") together with the buyer-RETAINED raw
// locked proofs. The endpoint confirms the signer is the committed buyer,
// that the lock has NOT expired (post-expiry belongs to refunds), and that
// the proofs' STRUCTURE matches the registered commitment (witnesses are not
// required yet — only the seller's key can produce them, which is the
// seller's completion step). It then enqueues a release on the
// one-row-per-escrow outbox and stores the raw proofs at stage
// "awaiting_seller_witness" atomically — the payout worker never claims that
// stage, and the seller's witnessed submission replaces it. A conflicting
// pending refund is a 409, never a silent flip.

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
    // The outputs are P2PK-locked to the payee, so sharing them with a party
    // who knows the escrow id is safe.
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

  const allowed = await applyRateLimit(
    req,
    res,
    "cashu-escrow-release-approve",
    {
      limit: 10,
      windowMs: 60_000,
    }
  );
  if (!allowed) return;

  const actionEvent = req.body?.actionEvent as Event | undefined;
  const proofs = req.body?.proofs as Proof[] | undefined;
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
  if (!Array.isArray(proofs) || proofs.length === 0) {
    return res.status(400).json({
      error:
        "The buyer-retained locked proofs are required so the seller can witness them.",
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
    // DB is authoritative on who the buyer is.
    if (registration.buyerPubkey !== verification.actorPubkey) {
      return res.status(403).json({
        error: "Only the escrow buyer can approve a release.",
        code: "not_buyer",
      });
    }
    const expiresAtSeconds = Math.floor(
      registration.expiresAt.getTime() / 1000
    );
    if (expiresAtSeconds <= Math.floor(Date.now() / 1000)) {
      return res.status(409).json({
        error:
          "Escrow has already expired; the funds can only be refunded to the buyer now.",
        code: "expired",
      });
    }

    // Structural check only (witnesses come from the seller next): the proofs
    // must be locked EXACTLY as committed (seller lock, locktime = expiry,
    // refund = buyer, SIG_INPUTS) and cover the committed amount.
    try {
      validateEscrowPayoutProofs(registration, "release", proofs, undefined, {
        requireWitness: false,
      });
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
    // makes the buyer's approval idempotent and a replay harmless.
    const { enqueued } = await enqueueEscrowAction(
      verification.escrowId,
      "release"
    );

    const outbox = await getEscrowOutboxEntryByEscrowId(verification.escrowId);
    if (!outbox) {
      throw new Error("Escrow outbox entry missing after enqueue.");
    }
    if (outbox.status === "done") {
      // Replay after completion: hand the outcome back again.
      return res.status(200).json({
        escrowId: verification.escrowId,
        status: "released",
        enqueued: false,
        payoutToken: payoutToken(registration.mintUrl, outbox.payoutOutputs),
      });
    }
    if (outbox.status === "pending") {
      // Atomic against concurrent worker claims (status guard in SQL).
      let attached = await attachEscrowPayoutPayload(outbox.outboxId, {
        proofs,
        stage: "awaiting_seller_witness",
      });
      if (!attached) {
        // Lost a claim race with the worker — re-read once and retry (same
        // pattern as the refund/release attach endpoints).
        const again = await getEscrowOutboxEntryByEscrowId(
          verification.escrowId
        );
        if (again && again.status === "pending") {
          attached = await attachEscrowPayoutPayload(again.outboxId, {
            proofs,
            stage: "awaiting_seller_witness",
          });
        }
      }
      if (attached) {
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
      error instanceof Error
        ? error.message
        : "Escrow release approval failed.";
    // A pending/completed refund (or completed release) is a client-visible
    // conflict, not a server fault.
    if (message.includes("already")) {
      return res.status(409).json({ error: message, code: "escrow_conflict" });
    }
    console.error("Cashu escrow release approval failed:", error);
    return res
      .status(500)
      .json({
        error: "Escrow release approval failed.",
        code: "internal_error",
      });
  }
}
