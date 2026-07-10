import type { NextApiRequest, NextApiResponse } from "next";
import {
  getStock,
  getAllStock,
  setStock,
  deductStock,
  restoreStock,
  checkAvailability,
  syncFromNostrEvent,
} from "@/utils/db/inventory-service";
import { verifyNip98Request } from "@/utils/nostr/nip98-auth";
import { applyRateLimit } from "@/utils/rate-limit";

// Bounds abuse of the write endpoint (e.g. griefing a seller's stock to zero
// via the unauthenticated buyer-path `deduct`). Generous enough for a large
// cart's per-item deducts plus retries within one checkout.
const INVENTORY_WRITE_RATE_LIMIT = { limit: 120, windowMs: 60_000 };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method === "GET") {
    return handleGet(req, res);
  }
  if (req.method === "POST") {
    return handlePost(req, res);
  }
  return res.status(405).json({ error: "Method not allowed" });
}

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const { productId, variantKey } = req.query;
  if (!productId || typeof productId !== "string") {
    return res.status(400).json({ error: "productId is required" });
  }

  try {
    if (variantKey && typeof variantKey === "string") {
      const result = await getStock(productId, variantKey);
      return res.status(200).json({ success: true, ...result });
    }
    const result = await getAllStock(productId);
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.error("Inventory GET error:", error);
    return res.status(500).json({ error: "Failed to fetch inventory" });
  }
}

async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  if (
    !(await applyRateLimit(
      req,
      res,
      "inventory-write",
      INVENTORY_WRITE_RATE_LIMIT
    ))
  ) {
    return;
  }

  const { action } = req.body;

  try {
    switch (action) {
      case "check": {
        const { productId, quantity = 1, selectedSize } = req.body;
        if (!productId)
          return res.status(400).json({ error: "productId is required" });
        const result = await checkAvailability(
          productId,
          quantity,
          selectedSize
        );
        return res.status(200).json({ success: true, ...result });
      }

      case "deduct": {
        // Buyer-path write: the caller is the buyer, who is often a guest with no
        // Nostr key, so this action can't be owner-bound like set/sync/restore.
        // Authoritative deduction also runs server-side at order completion
        // (send-order-email, mcp verify-payment, ucp order-service); this endpoint
        // is a best-effort fallback for paths that skip those (e.g. multi-seller
        // card finalize). deductStock is idempotent per orderId, so the buyer call
        // and the server-side call can never double-deduct the same sale.
        const { productId, amount, orderId, variantKey } = req.body;
        if (!productId || !amount || !orderId) {
          return res
            .status(400)
            .json({ error: "productId, amount, and orderId are required" });
        }
        // Must be a positive integer: a negative amount would INFLATE stock
        // (currentQty - (-n)), turning this open action into a tampering vector.
        const deductAmount = Number(amount);
        if (
          !Number.isInteger(deductAmount) ||
          deductAmount <= 0 ||
          deductAmount > 1_000_000
        ) {
          return res
            .status(400)
            .json({ error: "amount must be a positive integer" });
        }
        const result = await deductStock(
          productId,
          deductAmount,
          orderId,
          variantKey
        );
        if (!result.success) {
          return res.status(409).json(result);
        }
        return res.status(200).json(result);
      }

      case "set": {
        const { productId, sellerPubkey, quantity, variantKey, source } =
          req.body;
        if (!productId || !sellerPubkey || quantity === undefined) {
          return res.status(400).json({
            error: "productId, sellerPubkey, and quantity are required",
          });
        }
        // Overwriting stock must prove ownership of the seller pubkey.
        const setAuth = await verifyNip98Request(req, "POST", req.body);
        if (!setAuth.ok) {
          return res.status(401).json({ error: setAuth.error });
        }
        if (setAuth.pubkey !== sellerPubkey) {
          return res
            .status(403)
            .json({ error: "You can only modify your own inventory" });
        }
        const result = await setStock(
          productId,
          sellerPubkey,
          quantity,
          variantKey,
          source || "seller_override"
        );
        return res.status(200).json({ success: true, ...result });
      }

      case "restore": {
        const { productId, sellerPubkey, amount, orderId, variantKey } =
          req.body;
        if (!productId || !sellerPubkey || !amount || !orderId) {
          return res.status(400).json({
            error: "productId, sellerPubkey, amount, and orderId are required",
          });
        }
        const restoreAmount = Number(amount);
        if (
          !Number.isInteger(restoreAmount) ||
          restoreAmount <= 0 ||
          restoreAmount > 1_000_000
        ) {
          return res
            .status(400)
            .json({ error: "amount must be a positive integer" });
        }
        // Restoring stock (refund/cancel) must prove ownership of the seller
        // pubkey, otherwise anyone could inflate a seller's stock at will.
        const restoreAuth = await verifyNip98Request(req, "POST", req.body);
        if (!restoreAuth.ok) {
          return res.status(401).json({ error: restoreAuth.error });
        }
        if (restoreAuth.pubkey !== sellerPubkey) {
          return res
            .status(403)
            .json({ error: "You can only modify your own inventory" });
        }
        const result = await restoreStock(
          productId,
          restoreAmount,
          orderId,
          variantKey
        );
        return res.status(200).json(result);
      }

      case "sync": {
        const { productId, sellerPubkey, globalQuantity, sizeQuantities } =
          req.body;
        if (!productId || !sellerPubkey) {
          return res
            .status(400)
            .json({ error: "productId and sellerPubkey are required" });
        }
        // Writes that overwrite stock must prove ownership of the seller pubkey.
        const syncAuth = await verifyNip98Request(req, "POST", req.body);
        if (!syncAuth.ok) {
          return res.status(401).json({ error: syncAuth.error });
        }
        if (syncAuth.pubkey !== sellerPubkey) {
          return res
            .status(403)
            .json({ error: "You can only modify your own inventory" });
        }
        const sizeMap = sizeQuantities
          ? new Map<string, number>(
              Object.entries(sizeQuantities).map(([k, v]) => [k, Number(v)])
            )
          : undefined;
        await syncFromNostrEvent(
          productId,
          sellerPubkey,
          globalQuantity,
          sizeMap
        );
        return res.status(200).json({
          success: true,
          message: "Inventory synced from product event",
        });
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (error) {
    console.error("Inventory POST error:", error);
    return res
      .status(500)
      .json({ error: "Failed to process inventory operation" });
  }
}
