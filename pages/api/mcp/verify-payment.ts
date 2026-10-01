import type { NextApiRequest, NextApiResponse } from "next";
import {
  Mint as CashuMint,
  Wallet as CashuWallet,
  MintQuoteState,
} from "@cashu/cashu-ts";
import { authenticateRequest, initializeApiKeysTable } from "@/utils/mcp/auth";
import {
  getMcpOrder,
  getPendingLightningQuote,
} from "@/mcp/tools/purchase-tools";
import { recordRequest } from "@/utils/mcp/metrics";
import { applyRateLimit } from "@/utils/rate-limit";
import { claimX402Settlement } from "@/utils/db/x402-service";
import { decryptNsec } from "@/utils/mcp/nostr-signing";
import { checkLnbitsPayment } from "@/utils/x402/authority";
import { X402_LNBTC_MAINNET } from "@/utils/x402/constants";
import { runLightningSettlementTail } from "@/utils/mcp/lightning-settlement";

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

    // Settlement authority depends on which invoice authority issued the
    // invoice: platform-mint quotes are polled at the mint; seller-authority
    // (LNbits) invoices are polled at the seller's own node. In both cases
    // the authority's answer is the ONLY settlement signal, so it wins even
    // when the quote is past its advertised expiry (a payment in flight at
    // the deadline can still settle).
    let settled: boolean;
    let settledPreimage: string | undefined;
    if (pending.authority === "lnbits") {
      // Verify against the credential snapshot persisted when the invoice
      // was issued — never the seller's CURRENT config, so a disconnect or
      // key rotation after issuance can never strand a paid invoice.
      if (
        !pending.paymentHash ||
        !pending.authorityApiKey ||
        !pending.mintUrl
      ) {
        return res.status(400).json({
          error:
            "This order's Lightning invoice authority record is incomplete and cannot be verified.",
          orderId,
        });
      }
      const status = await checkLnbitsPayment({
        url: pending.mintUrl,
        apiKey: decryptNsec(pending.authorityApiKey),
        paymentHash: pending.paymentHash,
      });
      settled = status.paid;
      settledPreimage = status.preimage;
    } else {
      const cashuMint = new CashuMint(pending.mintUrl);
      const wallet = new CashuWallet(cashuMint);
      await wallet.loadMint();
      const quoteStatus = await wallet.checkMintQuoteBolt11(pending.quote);
      settled =
        quoteStatus.state === MintQuoteState.PAID ||
        quoteStatus.state === MintQuoteState.ISSUED;
    }

    if (settled) {
      // Commit the x402 receipt BEFORE the settlement tail reaps the quote
      // row: a crash after deletion but before this insert would strand a
      // paid order with neither quote nor receipt, and every later x402
      // retry would 402 with unknown_payment_hash. If the insert THROWS,
      // abort before settling — the quote row survives and the next poll
      // retries. (A false return just means the x402 settle path claimed it
      // first; proceed.)
      if (pending.paymentHash) {
        try {
          await claimX402Settlement({
            paymentHash: pending.paymentHash,
            network: X402_LNBTC_MAINNET,
            amountMsat: BigInt(pending.amount) * 1000n,
            orderId,
            apiKeyId: Number(apiKey.id),
            buyerPubkey: order.buyer_pubkey,
          });
        } catch (error) {
          console.error(
            "x402 receipt insert failed before settlement; aborting so the quote survives for retry:",
            error
          );
          return res.status(500).json({
            error:
              "Settlement receipt could not be recorded. The invoice is paid; poll again to retry confirmation.",
            orderId,
          });
        }
      }

      // Shared settlement tail (also used by the x402 preimage path):
      // atomically claim the row, mark paid, consume the discount code,
      // deduct stock, reap the row. A lost claim means another settler is
      // mid-flight — report the current order state.
      const won = await runLightningSettlementTail(
        pending,
        `ln_${pending.quote}`
      );
      if (!won) {
        // Another settler is finishing (or just finished) this order.
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
          ...(settledPreimage ? { preimage: settledPreimage } : {}),
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
