// GET /api/cashu/escrow/status?escrowId=<buyerPubkey>:<orderId>
//
// Escrow status lookup for the involved parties (locked / released /
// refunded, plus any pending payout action). The escrow id embeds the buyer
// pubkey and a high-entropy order id, so knowing it is proof of involvement;
// the response exposes only status + expiry, never amounts. It additionally:
//   - reports payloadAttached so a payload-less pending action (e.g. the
//     expiry sweep's auto-enqueued refunds) stays completable by the buyer;
//   - reports releaseAwaitingSeller + serves the raw locked proofs while a
//     buyer-approved release waits for the seller's witness (unspendable by
//     anyone else: seller-locked pre-expiry, buyer-refundable after);
//   - delivers the completed payout proofs (P2PK-locked to the payee, so
//     useless to anyone else) for BOTH refunds and releases.

import type { NextApiRequest, NextApiResponse } from "next";
import { getEncodedToken, type Proof } from "@cashu/cashu-ts";
import { applyRateLimit } from "@/utils/rate-limit";
import { isEscrowEnabled } from "@/utils/cashu/escrow-config";
import {
  getEscrowOutboxEntryByEscrowId,
  getEscrowRegistration,
} from "@/utils/db/cashu-escrow-service";

const ESCROW_ID_REGEX = /^[0-9a-f]{64}:.{1,128}$/;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Fail closed: escrow is inert until explicitly enabled and configured.
  if (!isEscrowEnabled()) {
    return res.status(403).json({
      error: "Cashu escrow is not enabled on this server.",
      code: "escrow_disabled",
    });
  }

  const allowed = await applyRateLimit(req, res, "cashu-escrow-status", {
    limit: 30,
    windowMs: 60_000,
  });
  if (!allowed) return;

  const escrowId = req.query.escrowId;
  if (typeof escrowId !== "string" || !ESCROW_ID_REGEX.test(escrowId)) {
    return res.status(400).json({
      error: "A valid escrow id is required.",
      code: "invalid_request",
    });
  }

  try {
    const registration = await getEscrowRegistration(escrowId);
    if (!registration) {
      return res
        .status(404)
        .json({ error: "Escrow not found.", code: "escrow_not_found" });
    }
    const outbox = await getEscrowOutboxEntryByEscrowId(escrowId);
    const pendingAction =
      outbox && outbox.status !== "done" ? outbox.action : null;
    const releaseAwaitingSeller =
      pendingAction === "release" &&
      outbox?.payoutPayload?.stage === "awaiting_seller_witness";

    let payoutToken: string | undefined;
    if (
      outbox &&
      outbox.status === "done" &&
      Array.isArray(outbox.payoutOutputs) &&
      outbox.payoutOutputs.length > 0
    ) {
      try {
        payoutToken = getEncodedToken({
          mint: registration.mintUrl,
          proofs: outbox.payoutOutputs as Proof[],
        });
      } catch {
        payoutToken = undefined;
      }
    }

    return res.status(200).json({
      escrowId: registration.escrowId,
      status: registration.status,
      expiresAt: Math.floor(registration.expiresAt.getTime() / 1000),
      pendingAction,
      payloadAttached: outbox ? outbox.payloadAttached : false,
      releaseAwaitingSeller,
      mintUrl: registration.mintUrl,
      ...(releaseAwaitingSeller && Array.isArray(outbox?.payoutPayload?.proofs)
        ? { releaseProofs: outbox.payoutPayload.proofs }
        : {}),
      ...(payoutToken ? { payoutToken } : {}),
    });
  } catch (error) {
    console.error("Cashu escrow status lookup failed:", error);
    return res
      .status(500)
      .json({ error: "Escrow status lookup failed.", code: "internal_error" });
  }
}
