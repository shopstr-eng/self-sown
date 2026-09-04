// POST /api/cashu/escrow/resolve
//
// The arbiter's dispute resolution. Accepts an arbiter-signed escrow action
// event (kind 31996, action "release" or "refund") together with the locked
// proofs carrying the required 2-of-3 witness (the arbiter's signature plus
// a counterparty's — see validateEscrowPayoutProofs). The endpoint confirms
// the signer is the REGISTERED, currently-allowlisted arbiter for this
// escrow (a plain buyer/seller signature is never enough here), validates
// the proofs with the payout worker's own validator, then enqueues the
// directed action on the one-row-per-escrow outbox and attaches the payload
// at stage "ready" atomically, so a 200 means the resolution can actually
// complete. A conflicting pending opposite action is a 409, never a silent
// flip — the arbiter cannot redirect an escrow the parties are already
// settling the other way.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Event } from "nostr-tools";
import { getEncodedToken, type Proof } from "@cashu/cashu-ts";
import { applyRateLimit } from "@/utils/rate-limit";
import {
  getEscrowArbiterPubkeys,
  isEscrowEnabled,
} from "@/utils/cashu/escrow-config";
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

  const allowed = await applyRateLimit(req, res, "cashu-escrow-resolve", {
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
        "The witnessed locked proofs are required so the resolution can actually be paid out.",
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
    // DB is authoritative on who the arbiter is: the escrow must have one
    // registered, and the signer must be exactly that key — a party's
    // signature never suffices for dispute resolution.
    if (!registration.arbiterPubkey) {
      return res.status(403).json({
        error: "This escrow has no registered arbiter.",
        code: "no_arbiter",
      });
    }
    if (registration.arbiterPubkey !== verification.actorPubkey) {
      return res.status(403).json({
        error: "Only the registered arbiter can resolve this escrow.",
        code: "not_arbiter",
      });
    }
    // The operator allowlist is re-checked at resolution time, so a revoked
    // arbiter cannot act on historical registrations.
    if (!getEscrowArbiterPubkeys().has(verification.actorPubkey)) {
      return res.status(403).json({
        error: "The registered arbiter is no longer allowlisted.",
        code: "arbiter_not_allowlisted",
      });
    }

    // Full validation (the payout worker's own checks): the committed 2-of-3
    // arbiter construction, the release-expiry / directed-refund witness
    // rules — including the arbiter's signature on every proof.
    try {
      validateEscrowPayoutProofs(
        registration,
        verification.action,
        payoutProofs,
        undefined,
        { directedByArbiter: true }
      );
    } catch (error) {
      return res.status(400).json({
        error:
          error instanceof Error
            ? error.message
            : "Resolution proofs failed validation.",
        code: "invalid_proofs",
      });
    }

    // Enqueued only after every skip/early-return above: the one-row outbox
    // makes the arbiter's direction idempotent and a replay harmless.
    const { enqueued } = await enqueueEscrowAction(
      verification.escrowId,
      verification.action
    );

    const outbox = await getEscrowOutboxEntryByEscrowId(verification.escrowId);
    if (!outbox) {
      throw new Error("Escrow outbox entry missing after enqueue.");
    }
    if (outbox.status === "done") {
      // Replay after completion: hand the directed payout back again.
      return res.status(200).json({
        escrowId: verification.escrowId,
        status: verification.action === "release" ? "released" : "refunded",
        enqueued: false,
        payoutToken: payoutToken(registration.mintUrl, outbox.payoutOutputs),
      });
    }
    if (outbox.status === "pending") {
      // Atomic against concurrent worker claims (status guard in SQL). The
      // "ready" stage makes the entry claimable by the payout worker (the
      // claim guard skips "awaiting_seller_witness" payloads).
      // directedByArbiter is server-attested (the arbiter binding was
      // verified above): the worker revalidates every payload before paying,
      // and needs this flag to honor the directed witness/timing rules at
      // payout time instead of re-judging under party rules.
      let attached = await attachEscrowPayoutPayload(outbox.outboxId, {
        proofs: payoutProofs,
        stage: "ready",
        directedByArbiter: true,
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
            directedByArbiter: true,
          });
        }
      }
      if (attached) {
        // Success is only reported once the payload really landed.
        return res.status(200).json({
          escrowId: verification.escrowId,
          status: "resolution_pending",
          enqueued,
          attached: true,
        });
      }
    }
    return res.status(200).json({
      escrowId: verification.escrowId,
      status: "resolution_processing",
      enqueued,
      attached: false,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Escrow resolution failed.";
    // A pending/completed opposite action is a client-visible conflict, not
    // a server fault.
    if (message.includes("already")) {
      return res.status(409).json({ error: message, code: "escrow_conflict" });
    }
    console.error("Cashu escrow resolution failed:", error);
    return res
      .status(500)
      .json({ error: "Escrow resolution failed.", code: "internal_error" });
  }
}
