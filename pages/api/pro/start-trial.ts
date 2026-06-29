import type { NextApiRequest, NextApiResponse } from "next";
import { applyRateLimit } from "@/utils/rate-limit";
import {
  buildProStartTrialProof,
  extractSignedEventFromRequest,
  verifySignedHttpRequestProof,
} from "@/utils/nostr/request-auth";
import { isProTerm } from "@/utils/pro/constants";
import { startNewUserProTrial } from "@/utils/pro/membership";

// Start a 30-day no-payment Pro trial for a new seller. The seller signs the
// request with their Nostr key (same proof pattern as create-subscription). No
// payment is collected; the trial carries a lapse timeline so the existing
// lifecycle cron reminds them to pay at trial end. One-time per seller — an
// existing membership row (trial or paid) is left untouched.
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (
    !(await applyRateLimit(req, res, "pro-start-trial", {
      limit: 20,
      windowMs: 60_000,
    }))
  )
    return;

  const { pubkey, term } = req.body || {};
  if (!pubkey || !isProTerm(term)) {
    return res.status(400).json({
      error: "pubkey and a valid term (monthly|yearly) are required",
    });
  }

  const verification = verifySignedHttpRequestProof(
    extractSignedEventFromRequest(req),
    buildProStartTrialProof({ pubkey, term })
  );
  if (!verification.ok) {
    return res.status(verification.status).json({ error: verification.error });
  }

  try {
    const { created, view } = await startNewUserProTrial(pubkey, term);
    return res.status(200).json({ created, view });
  } catch (error) {
    console.error("pro start-trial failed:", error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to start trial",
    });
  }
}
