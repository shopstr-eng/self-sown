// POST /api/cashu/escrow/register
//
// Accepts a buyer-signed escrow commitment event (see
// utils/cashu/escrow-commitment.ts) and durably registers it. The endpoint
// fails closed unless the operator has explicitly enabled escrow AND
// configured the mint and arbiter allowlists — until then buyers keep using
// the existing direct Cashu checkout, which remains the default.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Event } from "nostr-tools";
import { applyRateLimit } from "@/utils/rate-limit";
import { isEscrowEnabled } from "@/utils/cashu/escrow-config";
import { verifyEscrowCommitmentEvent } from "@/utils/cashu/escrow-commitment";
import { registerEscrowCommitment } from "@/utils/db/cashu-escrow-service";

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

  const allowed = await applyRateLimit(req, res, "cashu-escrow-register", {
    limit: 10,
    windowMs: 60_000,
  });
  if (!allowed) return;

  const commitmentEvent = req.body?.commitmentEvent as Event | undefined;
  if (
    !commitmentEvent ||
    typeof commitmentEvent !== "object" ||
    typeof commitmentEvent.content !== "string" ||
    !Array.isArray(commitmentEvent.tags)
  ) {
    return res.status(400).json({
      error: "A signed escrow commitment event is required.",
      code: "invalid_request",
    });
  }

  const verification = verifyEscrowCommitmentEvent(commitmentEvent);
  if (!verification.ok) {
    return res.status(400).json({
      error: verification.error,
      code: "invalid_commitment",
    });
  }

  try {
    const result = await registerEscrowCommitment(
      verification.escrowId,
      verification.commitment,
      commitmentEvent
    );
    return res.status(result.created ? 201 : 200).json({
      escrowId: result.escrowId,
      status: "locked",
      replayed: !result.created,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Escrow registration failed.";
    // Conflicting terms for an existing escrow id are a client-visible 409,
    // not a server fault.
    if (message.includes("terms differ")) {
      return res.status(409).json({ error: message, code: "escrow_conflict" });
    }
    console.error("Cashu escrow registration failed:", error);
    return res
      .status(500)
      .json({ error: "Escrow registration failed.", code: "internal_error" });
  }
}
