import { NextApiRequest, NextApiResponse } from "next";
import {
  createEmailFlow,
  getEmailFlows,
  createFlowStep,
} from "@/utils/db/db-service";
import {
  getDefaultFlowSteps,
  FlowType,
} from "@/utils/email/flow-email-templates";
import { applyRateLimit } from "@/utils/rate-limit";
import { requireProEntitlement } from "@/utils/pro/require-pro";
import { verifyNip98Request } from "@/utils/nostr/nip98-auth";

const RATE_LIMIT = { limit: 60, windowMs: 60 * 1000 };

const VALID_FLOW_TYPES: FlowType[] = [
  "welcome_series",
  "abandoned_cart",
  "post_purchase",
  "winback",
  "one_time",
];

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (!(await applyRateLimit(req, res, "email-flows-index", RATE_LIMIT)))
    return;

  if (req.method === "GET") {
    const { seller_pubkey } = req.query;

    if (!seller_pubkey || typeof seller_pubkey !== "string") {
      return res.status(400).json({ error: "seller_pubkey is required" });
    }

    // NIP-98: a seller's flow list is private (names, reply-to addresses).
    // The queried pubkey is caller-supplied, so require proof of control.
    const authResult = await verifyNip98Request(req, "GET");
    if (!authResult.ok) {
      return res.status(401).json({ error: authResult.error });
    }
    if (seller_pubkey !== authResult.pubkey) {
      return res.status(403).json({ error: "Not authorized" });
    }

    try {
      const flows = await getEmailFlows(authResult.pubkey);
      return res.status(200).json({ flows });
    } catch (error) {
      console.error("Error fetching email flows:", error);
      return res.status(500).json({ error: "Failed to fetch email flows" });
    }
  }

  if (req.method === "POST") {
    const { seller_pubkey, name, flow_type, use_defaults } = req.body;

    if (!seller_pubkey || !name || !flow_type) {
      return res
        .status(400)
        .json({ error: "seller_pubkey, name, and flow_type are required" });
    }

    if (!VALID_FLOW_TYPES.includes(flow_type)) {
      return res.status(400).json({
        error: `Invalid flow_type. Must be one of: ${VALID_FLOW_TYPES.join(
          ", "
        )}`,
      });
    }

    // NIP-98: seller_pubkey in the body is caller-supplied; without a proof,
    // anyone could create flows under a victim seller's pubkey.
    const authResult = await verifyNip98Request(req, "POST", req.body);
    if (!authResult.ok) {
      return res.status(401).json({ error: authResult.error });
    }
    if (seller_pubkey !== authResult.pubkey) {
      return res.status(403).json({ error: "Not authorized" });
    }

    // Custom email flows are Pro-only. Block creation for non-entitled sellers.
    if (!(await requireProEntitlement(authResult.pubkey, res))) return;

    try {
      const flow = await createEmailFlow({
        seller_pubkey: authResult.pubkey,
        name,
        flow_type,
      });

      if (use_defaults !== false) {
        const defaultSteps = getDefaultFlowSteps(flow_type as FlowType);
        for (const step of defaultSteps) {
          await createFlowStep({
            flow_id: flow.id,
            step_order: step.step_order,
            subject: step.subject,
            body_html: step.body_html,
            delay_hours: step.delay_hours,
          });
        }
      }

      return res.status(201).json({ flow });
    } catch (error) {
      console.error("Error creating email flow:", error);
      return res.status(500).json({ error: "Failed to create email flow" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
