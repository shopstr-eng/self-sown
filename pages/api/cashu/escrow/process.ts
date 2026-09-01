// POST /api/cashu/escrow/process
//
// Internal cron for the Cashu escrow payout worker. Gated by the shared
// FLOW_PROCESSOR_SECRET (no Nostr auth; there is no per-user caller), invoked
// periodically by the internal scheduler (utils/email/flow-scheduler.ts).
//
// Each run recovers stale claims, enqueues refunds for expired locked
// escrows, and drains pending outbox entries — performing the P2PK
// release/refund at the mint and finalizing with the claim fencing token.
// When escrow is not enabled and configured the sweep is a no-op, so this
// endpoint is safe to call unconditionally.

import type { NextApiRequest, NextApiResponse } from "next";
import { applyRateLimit } from "@/utils/rate-limit";
import {
  ESCROW_PAYOUT_BATCH_SIZE,
  runEscrowPayoutSweep,
} from "@/utils/cashu/escrow-payout-worker";

const MAX_BATCH_SIZE = 100;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const allowed = await applyRateLimit(req, res, "cashu-escrow-process", {
    limit: 10,
    windowMs: 60_000,
  });
  if (!allowed) return;

  const secret = req.headers["x-flow-processor-secret"] || req.body?.secret;
  const expectedSecret = process.env.FLOW_PROCESSOR_SECRET;
  if (!expectedSecret || secret !== expectedSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const rawBatch = Number(req.body?.batch_size);
  const batchSize =
    Number.isSafeInteger(rawBatch) && rawBatch >= 1
      ? Math.min(rawBatch, MAX_BATCH_SIZE)
      : ESCROW_PAYOUT_BATCH_SIZE;

  try {
    const summary = await runEscrowPayoutSweep({ batchSize });
    return res.status(200).json({ ok: true, ...summary });
  } catch (error) {
    console.error("cashu escrow payout sweep failed:", error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Escrow sweep failed",
    });
  }
}
