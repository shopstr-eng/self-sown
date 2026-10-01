// Shared Lightning settlement tail for MCP orders.
//
// Both verification surfaces — the legacy polling route
// (pages/api/mcp/verify-payment.ts) and the x402 preimage-settlement path
// (pages/api/mcp/create-order.ts) — must run the exact same sequence once a
// payment is confirmed: atomically claim the quote row, mark the order paid,
// consume the discount code, deduct stock, delete the quote. Extracted so
// the two surfaces cannot drift.

import {
  claimPendingLightningQuote,
  deletePendingLightningQuote,
  updateMcpOrderPayment,
  type PendingLightningQuote,
} from "@/mcp/tools/purchase-tools";
import { deductStock } from "@/utils/db/inventory-service";
import { markDiscountCodeUsed } from "@/utils/db/db-service";

/**
 * Returns true when this caller won the atomic claim and ran the side
 * effects; false when a concurrent settler holds a fresh claim (the caller
 * should re-read the order and report its current status).
 */
export async function runLightningSettlementTail(
  pending: PendingLightningQuote,
  paymentIntentId: string
): Promise<boolean> {
  // Claim the row atomically before any side effect: two racing settlers
  // must not both consume the discount code and deduct stock. A stale claim
  // is re-takable so a winner that crashes mid-settlement can't strand the
  // order (if it already flipped the order to paid, the order-status check
  // in the route returns before anyone re-claims).
  const claim = await claimPendingLightningQuote(pending.orderId);
  if (!claim) return false;

  await updateMcpOrderPayment(pending.orderId, paymentIntentId, "paid");

  // The invoice has settled — only now consume the discount code. If the
  // buyer never paid (or the quote expired), this branch never runs, so the
  // code's max_uses stays intact.
  if (pending.discountCode && pending.sellerPubkey) {
    try {
      await markDiscountCodeUsed(pending.discountCode, pending.sellerPubkey);
    } catch (markErr) {
      console.error(
        "Failed to mark discount code used (lightning settlement):",
        markErr
      );
    }
  }

  try {
    await deductStock(
      pending.productId,
      pending.quantity,
      pending.orderId,
      pending.inventoryVariantKey
    );
  } catch (invErr) {
    console.error("Inventory deduction failed (lightning settlement):", invErr);
  }

  // Settlement fully recorded — only now reap the quote row. Deleting any
  // earlier would destroy the only link between this order and the invoice a
  // late poll/settle needs.
  await deletePendingLightningQuote(pending.orderId);

  return true;
}
