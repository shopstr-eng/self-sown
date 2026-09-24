import type { NextApiRequest, NextApiResponse } from "next";
import {
  Mint as CashuMint,
  Wallet as CashuWallet,
  MintQuoteState,
} from "@cashu/cashu-ts";
import { authenticateRequest, initializeApiKeysTable } from "@/utils/mcp/auth";
import {
  claimPendingLightningQuote,
  deletePendingLightningQuote,
  getMcpOrder,
  getPendingLightningQuote,
  updateMcpOrderPayment,
} from "@/mcp/tools/purchase-tools";
import { recordRequest } from "@/utils/mcp/metrics";
import { deductStock } from "@/utils/db/inventory-service";
import { markDiscountCodeUsed } from "@/utils/db/db-service";
import { applyRateLimit } from "@/utils/rate-limit";

// Polled by clients waiting for invoice settlement; the cap is generous
// because polling cadence + retries can stack, but bounded so an open
// invoice loop cannot saturate the mint quote-check pipeline.
const RATE_LIMIT = { limit: 120, windowMs: 60 * 1000 };
const PER_KEY_LIMIT = { limit: 60, windowMs: 60 * 1000 };

let tablesReady = false;

async function ensureTables() {
  if (!tablesReady) {
    await initializeApiKeysTable();
    tablesReady = true;
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const requestStart = Date.now();

  // The WHOLE handler body — table init, rate limit, auth, and dispatch — sits
  // inside one try/catch. Table init and auth hit the DB directly, so an
  // outage in any preamble step must also resolve as the route's clean 500
  // JSON instead of an unhandled rejection. (The rate limiter itself fails
  // open on store errors by design.)
  try {
    await ensureTables();

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed. Use POST." });
    }

    if (
      !(await applyRateLimit(req, res, "mcp-verify-payment:ip", RATE_LIMIT))
    ) {
      recordRequest(Date.now() - requestStart, false, "verify-payment");
      return;
    }

    const apiKey = await authenticateRequest(req, res, "read_write");
    if (!apiKey) {
      recordRequest(Date.now() - requestStart, false, "verify-payment");
      return;
    }

    if (
      !(await applyRateLimit(
        req,
        res,
        "mcp-verify-payment:key",
        PER_KEY_LIMIT,
        String(apiKey.id)
      ))
    ) {
      recordRequest(Date.now() - requestStart, false, "verify-payment");
      return;
    }

    const originalEnd = res.end.bind(res);
    (res as any).end = function (...args: any[]) {
      const durationMs = Date.now() - requestStart;
      res.setHeader("X-Response-Time", `${durationMs}ms`);
      recordRequest(durationMs, res.statusCode < 500, "verify-payment");
      return originalEnd(...args);
    };

    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({ error: "orderId is required" });
    }

    const order = await getMcpOrder(orderId);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    if (order.buyer_pubkey !== apiKey.pubkey) {
      return res
        .status(403)
        .json({ error: "Not authorized to verify this order" });
    }

    if (order.payment_status === "paid") {
      return res.status(200).json({
        success: true,
        status: "paid",
        message: "Payment has already been confirmed.",
        orderId,
      });
    }

    // DB-backed lookup (mcp_lightning_quotes): a quote written by another
    // instance — or before a restart wiped this process — still verifies.
    // The accessor THROWS on a DB outage (caught below → retryable 500);
    // null means the quote is genuinely settled/expired/nonexistent.
    const pending = await getPendingLightningQuote(orderId);
    if (!pending) {
      if (
        order.payment_intent_id &&
        order.payment_intent_id.startsWith("fiat_")
      ) {
        return res.status(200).json({
          success: true,
          status: "pending_seller_confirmation",
          message:
            "This is a fiat payment. The seller must manually confirm receipt.",
          orderId,
        });
      }

      return res.status(400).json({
        error:
          "No pending Lightning payment found for this order. It may have expired.",
        orderId,
      });
    }

    const cashuMint = new CashuMint(pending.mintUrl);
    const wallet = new CashuWallet(cashuMint);
    await wallet.loadMint();
    const quoteStatus = await wallet.checkMintQuoteBolt11(pending.quote);

    if (
      quoteStatus.state === MintQuoteState.PAID ||
      quoteStatus.state === MintQuoteState.ISSUED
    ) {
      // The mint says the money arrived — this is the ONLY settlement
      // authority, so it wins even when the quote is past its advertised
      // expiry (a payment in flight at the deadline can still settle).
      //
      // Claim the row atomically before any side effect: two racing polls
      // (retries, or polls landing on different instances now that quotes
      // live in Postgres) must not both consume the discount code and
      // deduct stock. A stale claim is re-takable so a winner that crashes
      // mid-settlement can't strand the order.
      const claim = await claimPendingLightningQuote(orderId);
      if (!claim) {
        // Another poll is settling (or just settled) this order.
        const fresh = await getMcpOrder(orderId);
        if (fresh?.payment_status === "paid") {
          return res.status(200).json({
            success: true,
            status: "paid",
            message: "Payment has already been confirmed.",
            orderId,
          });
        }
        return res.status(200).json({
          success: true,
          status: "unpaid",
          message:
            "Payment received; confirmation is in progress. Please poll again.",
          orderId,
          payment: {
            method: "lightning",
            amount: pending.amount,
            currency: "sats",
            quoteId: pending.quote,
            mintUrl: pending.mintUrl,
          },
        });
      }

      await updateMcpOrderPayment(orderId, `ln_${pending.quote}`, "paid");

      // Lightning invoice has settled — only now do we consume the discount
      // code. If the buyer never paid (or the quote expired), this branch
      // never runs, so the code's max_uses stays intact and the buyer can
      // reapply it on a fresh order.
      if (pending.discountCode && pending.sellerPubkey) {
        try {
          await markDiscountCodeUsed(
            pending.discountCode,
            pending.sellerPubkey
          );
        } catch (markErr) {
          console.error(
            "Failed to mark discount code used (lightning verify):",
            markErr
          );
        }
      }

      try {
        await deductStock(
          pending.productId,
          pending.quantity,
          orderId,
          pending.inventoryVariantKey
        );
      } catch (invErr) {
        console.error("Inventory deduction failed (lightning verify):", invErr);
      }

      // Settlement fully recorded — only now reap the quote row. Deleting
      // any earlier would destroy the only link between this order and the
      // mint quote a late poll needs.
      await deletePendingLightningQuote(orderId);

      // NOTE: No automatic shipping-label purchase for Lightning. Auto-purchase
      // spends the seller's own Shippo funds, so it only runs for payments the
      // server can independently verify (Stripe card). Lightning/Cashu orders
      // are always shipped via the manual "Buy label" button on the dashboard.

      return res.status(200).json({
        success: true,
        status: "paid",
        message:
          "Lightning payment confirmed! Your order is now being processed.",
        orderId,
        payment: {
          method: "lightning",
          amount: pending.amount,
          currency: "sats",
          quoteId: pending.quote,
        },
      });
    }

    // Mint says UNPAID. Past the advertised expiry no new payment can start,
    // so tell the agent the invoice is done — but RETAIN the row for the
    // grace period: a payment already in flight at the deadline can still
    // settle, and the next poll must still find the quote to confirm it.
    if (pending.expiresAt && Date.parse(pending.expiresAt) <= Date.now()) {
      return res.status(400).json({
        error:
          "No pending Lightning payment found for this order. It may have expired.",
        orderId,
      });
    }

    return res.status(200).json({
      success: true,
      status: "unpaid",
      message: "Payment has not been received yet. Please pay the invoice.",
      orderId,
      payment: {
        method: "lightning",
        amount: pending.amount,
        currency: "sats",
        quoteId: pending.quote,
        mintUrl: pending.mintUrl,
      },
    });
  } catch (error) {
    console.error("Payment verification failed:", error);
    return res.status(500).json({
      error: "Failed to verify payment",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
