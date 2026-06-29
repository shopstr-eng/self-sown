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

const RATE_LIMIT = { limit: 60, windowMs: 60 * 1000 };
const PER_KEY_LIMIT = { limit: 30, windowMs: 60 * 1000 };

let tablesReady = false;
async function ensureTables() {
  if (!tablesReady) {
    await initializeApiKeysTable();
    await initCheckoutSessionsTable();
    tablesReady = true;
  }
}

/**
 * POST /api/ucp/checkout/sessions/[id]/complete — explicitly complete a session.
 *
 * UCP's checkout lifecycle has a `complete` operation that an agent calls once it
 * believes the buyer-side payment is done. We do NOT run a parallel order state
 * machine: completion just reconciles the session against the canonical
 * `mcp_orders.payment_status` and records the outcome.
 *
 *   - order paid               → completed
 *   - order processing         → complete_in_progress
 *   - order still pending       → complete_in_progress (completion acknowledged,
 *                                  awaiting settlement; read-time reconcile or a
 *                                  later complete advances it to completed)
 *   - order failed             → requires_escalation
 *   - order refunded/canceled  → canceled
 *
 * Owner-only (not-found and not-owned both 404) and idempotent: a session that
 * is already completed/canceled is returned unchanged.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");

  if (req.method === "OPTIONS") {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(204).end();
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await applyRateLimit(req, res, "ucp-checkout-complete:ip", RATE_LIMIT)))
    return;

  await ensureTables();

  const apiKey = await authenticateRequest(req, res, "read_write");
  if (!apiKey) return;

  if (
    !(await applyRateLimit(
      req,
      res,
      "ucp-checkout-complete:key",
      PER_KEY_LIMIT,
      String(apiKey.id)
    ))
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

    // Idempotent: a terminal session is returned as-is.
    if (TERMINAL_CHECKOUT_STATUSES.includes(row.status)) {
      return res.status(200).json(formatCheckoutSession(row, baseUrl));
    }

    // No underlying order to reconcile (e.g. a subscription whose first payment
    // is confirmed out of band): acknowledge the completion attempt.
    if (!row.mcp_order_id) {
      const next: CheckoutSessionStatus = "complete_in_progress";
      const messages: CheckoutSessionMessage[] = [
        ...(row.messages || []),
        makeMessage(
          next,
          "Completion requested; confirm the payment with the provided client secret."
        ),
      ];
      const updated = await updateCheckoutSessionStatus(id, next, messages);
      return res
        .status(200)
        .json(formatCheckoutSession(updated || row, baseUrl));
    }

    let next: CheckoutSessionStatus;
    let note: string;
    try {
      const order = await getMcpOrder(row.mcp_order_id);
      const reconciled = reconcileStatusFromOrder(
        row.status,
        order?.payment_status
      );
      if (reconciled === row.status) {
        // The order hasn't settled yet: record that completion was requested.
        next = "complete_in_progress";
        note = "Completion requested; awaiting payment confirmation.";
      } else {
        next = reconciled;
        note =
          next === "completed"
            ? "Payment confirmed; the order is complete."
            : next === "requires_escalation"
              ? "Payment failed; this needs attention."
              : next === "canceled"
                ? "The order was refunded or canceled."
                : "Payment is processing.";
      }
    } catch (error) {
      // A reconciliation lookup failure shouldn't 500 the completion call; flag
      // it for escalation so the agent retries or contacts the seller.
      console.error("UCP checkout complete reconcile error:", error);
      next = "requires_escalation";
      note = "Could not confirm payment status; please retry shortly.";
    }

    if (next === row.status) {
      return res.status(200).json(formatCheckoutSession(row, baseUrl));
    }

    const messages: CheckoutSessionMessage[] = [
      ...(row.messages || []),
      makeMessage(
        next,
        note,
        next === "requires_escalation" ? "error" : undefined
      ),
    ];
    const updated = await updateCheckoutSessionStatus(id, next, messages);
    return res.status(200).json(formatCheckoutSession(updated || row, baseUrl));
  } catch (error) {
    console.error("UCP checkout complete error:", error);
    return res
      .status(500)
      .json({ error: "Failed to complete checkout session" });
  }
}
