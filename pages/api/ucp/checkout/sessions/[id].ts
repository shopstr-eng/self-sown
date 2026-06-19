import type { NextApiRequest, NextApiResponse } from "next";
import { applyRateLimit } from "@/utils/rate-limit";
import { authenticateRequest, initializeApiKeysTable } from "@/utils/mcp/auth";
import { getMcpOrder } from "@/mcp/tools/purchase-tools";
import { deriveBaseUrl } from "@/utils/ucp/seller-host";
import {
  formatCheckoutSession,
  getCheckoutSession,
  initCheckoutSessionsTable,
  makeMessage,
  reconcileStatusFromOrder,
  TERMINAL_CHECKOUT_STATUSES,
  updateCheckoutSessionStatus,
  type CheckoutSessionMessage,
  type CheckoutSessionStatus,
} from "@/utils/ucp/checkout-store";

const RATE_LIMIT = { limit: 120, windowMs: 60 * 1000 };
const PER_KEY_LIMIT = { limit: 60, windowMs: 60 * 1000 };

let tablesReady = false;
async function ensureTables() {
  if (!tablesReady) {
    await initializeApiKeysTable();
    await initCheckoutSessionsTable();
    tablesReady = true;
  }
}

const STATUS_NOTE: Record<string, string> = {
  completed: "Payment confirmed; the order is complete.",
  complete_in_progress: "Payment is processing.",
  requires_escalation: "Payment failed; this needs attention.",
  canceled: "The order was refunded or canceled.",
};

/**
 * GET /api/ucp/checkout/sessions/[id] — read one checkout session.
 *
 * Owner-only: a session is visible solely to the API key whose pubkey opened it
 * (not-found and not-owned both return 404 so sessions can't be enumerated).
 * The session status is reconciled on read against the canonical
 * `mcp_orders.payment_status`, so a Lightning/Stripe order that settled out of
 * band is reflected without a second payment state machine.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");

  if (req.method === "OPTIONS") {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(204).end();
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!applyRateLimit(req, res, "ucp-checkout-session:ip", RATE_LIMIT)) return;

  await ensureTables();

  const apiKey = await authenticateRequest(req, res, "read_write");
  if (!apiKey) return;

  if (
    !applyRateLimit(
      req,
      res,
      "ucp-checkout-session:key",
      PER_KEY_LIMIT,
      String(apiKey.id)
    )
  ) {
    return;
  }

  const id = typeof req.query.id === "string" ? req.query.id : "";
  if (!id) {
    return res.status(400).json({ error: "Session id is required" });
  }

  const baseUrl = deriveBaseUrl(req);

  try {
    const row = await getCheckoutSession(id);
    // Same 404 for missing and not-owned: don't reveal another key's sessions.
    if (!row || row.buyer_pubkey !== apiKey.pubkey) {
      return res.status(404).json({ error: "Checkout session not found" });
    }

    let current = row;
    if (row.mcp_order_id && !TERMINAL_CHECKOUT_STATUSES.includes(row.status)) {
      try {
        const order = await getMcpOrder(row.mcp_order_id);
        const next = reconcileStatusFromOrder(
          row.status,
          order?.payment_status
        );
        if (next !== row.status) {
          const messages: CheckoutSessionMessage[] = [
            ...(row.messages || []),
            makeMessage(
              next,
              STATUS_NOTE[next] || `Status updated to ${next}.`
            ),
          ];
          const updated = await updateCheckoutSessionStatus(
            id,
            next as CheckoutSessionStatus,
            messages
          );
          if (updated) current = updated;
        }
      } catch (error) {
        // A reconciliation failure must not block reading the session.
        console.error("UCP checkout reconcile error:", error);
      }
    }

    return res.status(200).json(formatCheckoutSession(current, baseUrl));
  } catch (error) {
    console.error("UCP checkout get error:", error);
    return res.status(500).json({ error: "Failed to read checkout session" });
  }
}
