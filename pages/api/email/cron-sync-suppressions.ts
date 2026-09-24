import type { NextApiRequest, NextApiResponse } from "next";
import { applyRateLimit } from "@/utils/rate-limit";
import { syncSendGridSuppressions } from "@/utils/email/sendgrid-suppressions";

// Internal cron: pull SendGrid's hard-bounce / spam-report suppression lists
// and record the addresses as per-seller 'suppressed' unsubscribes so future
// broadcast audiences skip addresses that provably cannot receive mail.
// Gated by the shared FLOW_PROCESSOR_SECRET (no Nostr auth; there is no
// per-user caller), invoked by the internal scheduler
// (see utils/email/flow-scheduler.ts).
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (
    !(await applyRateLimit(req, res, "email-cron-sync-suppressions", {
      limit: 10,
      windowMs: 60_000,
    }))
  )
    return;

  const secret = req.headers["x-flow-processor-secret"] || req.body?.secret;
  const expectedSecret = process.env.FLOW_PROCESSOR_SECRET;
  if (!expectedSecret || secret !== expectedSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const result = await syncSendGridSuppressions();
    // A failed sync (SendGrid outage, DB error) is retryable and already
    // fail-closed on the watermark, so surface it as 500 for the scheduler
    // logs without crashing the process.
    return res.status(result.ok ? 200 : 500).json(result);
  } catch (error) {
    console.error("email cron-sync-suppressions failed:", error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Suppression sync failed",
    });
  }
}
