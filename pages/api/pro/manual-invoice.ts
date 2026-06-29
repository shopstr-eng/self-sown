import type { NextApiRequest, NextApiResponse } from "next";
import { randomBytes } from "crypto";
import { applyRateLimit } from "@/utils/rate-limit";
import {
  buildProManualInvoiceProof,
  extractSignedEventFromRequest,
  verifySignedHttpRequestProof,
} from "@/utils/nostr/request-auth";
import {
  addDays,
  isProManualMethod,
  isProTerm,
  PRO_MANUAL_GRACE_DAYS,
  proPriceCents,
  proPriceUsd,
  WRANGLER_LIFETIME_PRICE_CENTS,
  WRANGLER_LIFETIME_PRICE_USD,
} from "@/utils/pro/constants";
import { createProManualInvoice } from "@/utils/db/pro-membership";
import { createPlatformBitcoinInvoice } from "@/utils/pro/lightning-pro";

// Issue a manual Pro invoice (one week to pay). Bitcoin invoices route to the
// Milk Market Lightning address and auto-verify; fiat returns the platform's
// payment handles and is confirmed by an operator. Pass `lifetime: true`
// (instead of a term) for a one-time Wrangler lifetime purchase.
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (
    !(await applyRateLimit(req, res, "pro-manual-invoice", {
      limit: 20,
      windowMs: 60_000,
    }))
  )
    return;

  const { pubkey, term, method, lifetime } = req.body || {};
  const isLifetime = lifetime === true || lifetime === "true";
  if (
    !pubkey ||
    !isProManualMethod(method) ||
    (!isLifetime && !isProTerm(term))
  ) {
    return res.status(400).json({
      error:
        "pubkey, method (bitcoin|fiat), and either a valid term (monthly|yearly) or lifetime are required",
    });
  }

  const verification = verifySignedHttpRequestProof(
    extractSignedEventFromRequest(req),
    buildProManualInvoiceProof(
      isLifetime ? { pubkey, method, lifetime: true } : { pubkey, term, method }
    )
  );
  if (!verification.ok) {
    return res.status(verification.status).json({ error: verification.error });
  }

  try {
    const invoiceId = `pmi_${randomBytes(12).toString("hex")}`;
    const amountUsdCents = isLifetime
      ? WRANGLER_LIFETIME_PRICE_CENTS
      : proPriceCents(term);
    const amountUsd = isLifetime
      ? WRANGLER_LIFETIME_PRICE_USD
      : proPriceUsd(term);
    const invoiceTerm = isLifetime ? null : term;
    const planLabel = isLifetime ? "Wrangler (lifetime)" : `Herd (${term})`;
    const dueAt = addDays(new Date(), PRO_MANUAL_GRACE_DAYS);

    if (method === "bitcoin") {
      const invoice = await createPlatformBitcoinInvoice(
        amountUsd,
        `Milk Market ${planLabel}`
      );
      if (!invoice) {
        return res
          .status(503)
          .json({ error: "Bitcoin payments are not available right now." });
      }

      await createProManualInvoice({
        invoiceId,
        pubkey,
        term: invoiceTerm,
        lifetime: isLifetime,
        method,
        amountUsdCents,
        amountSats: invoice.sats,
        bolt11: invoice.bolt11,
        verifyUrl: invoice.verify,
        paymentHash: invoice.paymentHash,
        dueAt,
      });

      return res.status(200).json({
        invoiceId,
        method,
        term: invoiceTerm,
        lifetime: isLifetime,
        amountUsd,
        amountSats: invoice.sats,
        bolt11: invoice.bolt11,
        dueAt: dueAt.toISOString(),
      });
    }

    // Manual fiat — return the platform's payment handles (if configured).
    const fiatHandles = process.env.MILK_MARKET_FIAT_HANDLES || "";
    await createProManualInvoice({
      invoiceId,
      pubkey,
      term: invoiceTerm,
      lifetime: isLifetime,
      method,
      amountUsdCents,
      dueAt,
    });

    return res.status(200).json({
      invoiceId,
      method,
      term: invoiceTerm,
      lifetime: isLifetime,
      amountUsd,
      fiatHandles,
      dueAt: dueAt.toISOString(),
      note: "After paying, the Milk Market team will confirm your payment and activate your membership.",
    });
  } catch (error) {
    console.error("pro manual-invoice failed:", error);
    return res.status(500).json({
      error:
        error instanceof Error ? error.message : "Failed to create invoice",
    });
  }
}
