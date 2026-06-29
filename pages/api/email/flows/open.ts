/**
 * Public open-tracking pixel for custom email flows.
 *
 * The recipient's mail client hits this when it loads the hidden 1x1 image we
 * embed in flow emails (see `flow-open-tracking.ts`). We verify the signed
 * token, record an open (best-effort — a failed insert must never break the
 * image response), and return a transparent GIF. We store no IP/user-agent/
 * recipient email. Opens are approximate by nature, so we surface them to
 * sellers as estimates.
 */
import type { NextApiRequest, NextApiResponse } from "next";
import { verifyFlowOpenToken } from "@/utils/email/flow-open-tracking";
import { recordFlowOpen } from "@/utils/db/db-service";
import { applyRateLimit } from "@/utils/rate-limit";

// Generous because mail-client image proxies (e.g. Gmail) can batch many
// recipients behind a few IPs; opens are estimates so occasional drops are fine.
const RATE_LIMIT = { limit: 600, windowMs: 60 * 1000 };

// 1x1 transparent GIF.
const PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64"
);

function sendPixel(res: NextApiResponse) {
  res.setHeader("Content-Type", "image/gif");
  res.setHeader("Content-Length", String(PIXEL.length));
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, private"
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.status(200).send(PIXEL);
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!(await applyRateLimit(req, res, "email-flow-open", RATE_LIMIT))) return;

  const raw = req.query.t;
  const token = Array.isArray(raw) ? raw[0] : raw;
  const decoded = token ? verifyFlowOpenToken(token) : null;

  if (decoded) {
    try {
      await recordFlowOpen({
        flowId: decoded.flowId,
        stepId: decoded.stepId,
        enrollmentId: decoded.enrollmentId,
        executionId: decoded.executionId,
        sellerPubkey: decoded.sellerPubkey,
      });
    } catch (err) {
      console.error("email-flow open record error:", err);
      // Best-effort: a recording failure must not break the image response.
    }
  }

  return sendPixel(res);
}
