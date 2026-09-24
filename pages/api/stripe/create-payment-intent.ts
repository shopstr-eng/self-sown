import type { NextApiRequest, NextApiResponse } from "next";
import Stripe from "stripe";
import { getStripeConnectAccount } from "@/utils/db/db-service";
import {
  isCrypto,
  toSmallestUnit,
  satsToUSD,
  isExchangeRateError,
  EXCHANGE_RATE_ERROR_CODE,
} from "@/utils/stripe/currency";
import { getSelfHostConfig, isSelfHostTenant } from "@/utils/self-host/config";
import {
  registerApplePayDomain,
  trustedRegistrationHost,
} from "@/utils/stripe/apple-pay";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2025-09-30.clover",
});

// Apple Pay domain registration is a privileged Connect-scoped call, so the
// registrable domain must be trustworthy: the canonical platform host, or a
// verified custom domain owned by the seller being charged. Anything else
// (spoofed Host headers, other sellers' domains) skips registration — the
// Host header alone is never trusted.
interface SellerSplit {
  sellerPubkey: string;
  // Preferred: per-seller subtotal already in seller-currency smallest units
  // (cents for fiat, sats for sats, whole units for zero-decimal currencies).
  // The frontend ceils each line to smallest units and sums them in the
  // seller's native currency before sending. The API treats the sum of these
  // as the source of truth for the buyer charge — no further per-split
  // rounding can introduce a sum-of-splits-exceeds-total mismatch.
  amountSmallest?: number;
  // Legacy raw-amount field, kept for back-compat with any older callers.
  amount?: number;
  currency: string;
  // Optional affiliate attribution. ONLY the code string is honored: the
  // rebate amount and affiliate/code IDs are always resolved server-side
  // from the stored, seller-scoped code row. The remaining fields are
  // legacy request shape and are IGNORED — a caller must never be able to
  // set the rebate amount or point it at arbitrary affiliate IDs.
  affiliateRebateSmallest?: number;
  affiliateAccountId?: string | null;
  affiliateId?: number;
  affiliateCodeId?: number;
  affiliateCode?: string;
}
import { applyRateLimit } from "@/utils/rate-limit";
import {
  withStripeRetry,
  stableIdempotencyKey,
} from "@/utils/stripe/retry-service";
import {
  recordPendingPayment,
  updatePendingPayment,
  SPLIT_AUTHORITY_METADATA_KEY,
  SPLIT_AUTHORITY_PENDING_RECORD,
  SUBSCRIPTION_TERMINAL_METADATA_KEY,
} from "@/utils/stripe/pending-payments";
import { resolveDonationCut } from "@/utils/stripe/donation";
import { recordShippingCheckoutContexts } from "@/utils/db/shipping-service";
import {
  sanitizeCheckoutContexts,
  stripeCheckoutRef,
} from "@/utils/shipping/checkout-context";
import {
  computeRebateSmallest,
  isAffiliateCodeValid,
  isSelfReferral,
  lookupAffiliateCode,
} from "@/utils/db/affiliates";

// Server-owned metadata keys a caller must never inject. They back
// fail-closed payment verification and payout authority, so they are
// stripped from client metadata before ANY use — the Stripe PaymentIntent
// metadata and the durable pending-payment record alike.
const SERVER_OWNED_METADATA_KEYS = new Set([
  "sellerSplitPubkeys",
  "sellerSplits",
  "transferGroup",
  "isMultiMerchant",
  SPLIT_AUTHORITY_METADATA_KEY,
  // Marks a split record as a cancelled subscription's, making it prunable —
  // an injected copy would let a buyer get their own card payment's payout
  // authority record swept before process-transfers ran.
  SUBSCRIPTION_TERMINAL_METADATA_KEY,
]);

function stripServerOwnedMetadata(metadata: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== "object") return {};
  const copy: Record<string, unknown> = {
    ...(metadata as Record<string, unknown>),
  };
  for (const key of SERVER_OWNED_METADATA_KEYS) delete copy[key];
  return copy;
}

// Rate limit: per-IP cap to bound abuse of payment endpoints.
const RATE_LIMIT = { limit: 30, windowMs: 60000 };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (
    !(await applyRateLimit(
      req,
      res,
      "stripe-create-payment-intent",
      RATE_LIMIT
    ))
  )
    return;

  try {
    const {
      amount,
      currency,
      customerEmail,
      productTitle,
      productDescription,
      metadata,
      sellerSplits,
      salesTaxSmallest,
      taxCalculationId,
      // Checkout-time shipping binding for the auto-label purchase route:
      // persisted server-side keyed by the VERIFIED PaymentIntent id so the
      // post-payment auto-purchase POST derives order/product/destination
      // from this record instead of trusting the buyer's request body.
      shippingContexts,
    } = req.body;

    // Stripe metadata values are capped at 500 chars; truncate any long strings
    // (e.g. productId list for large carts) so the API doesn't reject the call.
    const safeMetadata: Record<string, string> = {};
    if (metadata && typeof metadata === "object") {
      for (const [k, v] of Object.entries(metadata)) {
        if (v === undefined || v === null) continue;
        const s = String(v);
        safeMetadata[k] = s.length > 490 ? s.slice(0, 487) + "..." : s;
      }
    }
    // These keys are server-owned proof of which sellers a charge belongs to
    // (order-email payment verification trusts them fail-closed) and of
    // payout authority (process-transfers treats stamped split details as
    // the payout source of truth). A caller must never set them: in the
    // normal multi-merchant branch the server's value would override anyway,
    // but when that value is omitted (oversized pubkey list) — or anywhere on
    // the single-seller path — an injected copy would survive and spoof
    // seller membership or fabricate payout authority.
    delete safeMetadata.sellerSplitPubkeys;
    delete safeMetadata.sellerSplits;
    delete safeMetadata.transferGroup;
    delete safeMetadata.isMultiMerchant;
    delete safeMetadata[SPLIT_AUTHORITY_METADATA_KEY];
    delete safeMetadata[SUBSCRIPTION_TERMINAL_METADATA_KEY];

    // Validate customer email format if provided — Stripe rejects malformed
    // values and the resulting 400 surfaces as "invoice generation error".
    let safeCustomerEmail: string | undefined;
    if (customerEmail && typeof customerEmail === "string") {
      const trimmed = customerEmail.trim();
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
        safeCustomerEmail = trimmed;
      }
    }

    const requestedTaxSmallest =
      typeof salesTaxSmallest === "number" && salesTaxSmallest > 0
        ? Math.ceil(salesTaxSmallest)
        : 0;

    let amountInSmallestUnit: number;
    let stripeCurrency: string;

    if (isCrypto(currency)) {
      let sats = currency.toLowerCase() === "btc" ? amount * 100000000 : amount;
      const usdAmount = await satsToUSD(sats);
      amountInSmallestUnit = Math.ceil(usdAmount * 100);
      stripeCurrency = "usd";
    } else {
      amountInSmallestUnit = toSmallestUnit(amount, currency);
      stripeCurrency = currency.toLowerCase();
    }

    const isMultiMerchant =
      sellerSplits && Array.isArray(sellerSplits) && sellerSplits.length > 1;

    // Self-host: this instance belongs to ONE seller and card charges run
    // directly on their OWN standard Stripe account (the module client above is
    // built from that key) — no Connect, no application fee, no transfers. A
    // multi-seller cart can't be settled here, so refuse it up-front.
    const selfHostCfg = getSelfHostConfig();
    const selfHost = selfHostCfg.enabled;
    if (selfHost && isMultiMerchant) {
      return res.status(400).json({
        error: "This store only supports single-seller checkout",
      });
    }

    // Self-host: card charges require the OWNER to have explicitly turned on
    // their own standard Stripe account AND configured a secret key. Enforce it
    // server-side — hiding the card button in seller-status is presentation, not
    // authorization, so a direct API caller must be refused here too.
    if (
      selfHost &&
      (!selfHostCfg.ownStripe || !process.env.STRIPE_SECRET_KEY)
    ) {
      return res.status(400).json({
        error: "Card payments are not enabled on this store",
      });
    }

    // Self-host: card charges land directly on the OWNER's own Stripe account,
    // so the only seller that may be checked out here is the configured tenant.
    // Refuse a charge for any other seller's item (fail closed) so the owner's
    // account is never billed for a listing that isn't theirs.
    if (selfHost && !isSelfHostTenant(metadata?.sellerPubkey)) {
      return res.status(400).json({
        error: "This store only sells its own products",
      });
    }

    // Resolve the single-seller's connected Stripe account once. Both the
    // server-side tax gate and the direct-charge routing below need it; it
    // never applies to multi-merchant carts or the platform account. In
    // self-host we force it null so the charge lands directly on the owner's own
    // account (no Connect routing, application fee, or platform donation cut).
    const singleSellerPubkey = metadata?.sellerPubkey;
    const singleSellerConnect =
      !selfHost &&
      !isMultiMerchant &&
      singleSellerPubkey &&
      singleSellerPubkey !== process.env.NEXT_PUBLIC_SELF_SOWN_PK
        ? await getStripeConnectAccount(singleSellerPubkey)
        : null;

    // Resolve the effective sales tax server-side. Tax is opt-in per seller and
    // only honored on single-seller direct charges; multi-merchant carts never
    // add tax in v1. Never trust the client-sent amount without confirming the
    // seller actually has tax collection enabled.
    let taxAddSmallest = 0;
    if (
      !isMultiMerchant &&
      requestedTaxSmallest > 0 &&
      singleSellerConnect &&
      singleSellerConnect.charges_enabled &&
      singleSellerConnect.tax_enabled
    ) {
      taxAddSmallest = requestedTaxSmallest;
    }

    let transferGroup = "";
    const splitDetails: {
      pubkey: string;
      amountCents: number;
      accountId: string;
      donationPercent: number;
      donationCutSmallest: number;
      affiliateRebateSmallest: number;
      affiliateBuyerDiscountSmallest: number;
      affiliateAccountId: string | null;
      affiliateId: number | null;
      affiliateCodeId: number | null;
      affiliateCode: string | null;
    }[] = [];

    if (isMultiMerchant) {
      transferGroup = `cart_${Date.now()}_${Math.random()
        .toString(36)
        .substring(2, 8)}`;

      const seenSellerPubkeys = new Set<string>();
      for (const split of sellerSplits as SellerSplit[]) {
        // Payout claims key on (paymentIntentId, sellerPubkey): a duplicated
        // seller would pay once and misreport the rest while the buyer is
        // charged the full split sum. Reject up front.
        if (seenSellerPubkeys.has(split.sellerPubkey)) {
          return res.status(400).json({ error: "Duplicate seller in split" });
        }
        seenSellerPubkeys.add(split.sellerPubkey);
        const isPlatformAccount =
          split.sellerPubkey === process.env.NEXT_PUBLIC_SELF_SOWN_PK;

        let accountId = "";
        if (!isPlatformAccount) {
          const connectAccount = await getStripeConnectAccount(
            split.sellerPubkey
          );
          if (!connectAccount || !connectAccount.charges_enabled) {
            return res.status(400).json({
              error: `Seller ${split.sellerPubkey.substring(
                0,
                8
              )}... does not have Stripe enabled`,
            });
          }
          accountId = connectAccount.stripe_account_id;
        }

        let splitAmountSmallest: number;
        if (isCrypto(split.currency)) {
          // Crypto splits must be FX-converted to USD cents (Stripe never
          // settles in sats/btc). The frontend has already aggregated the
          // seller's lines and ceiled to satoshi precision, so this is the
          // only remaining ceil — one per seller.
          const sellerSats =
            typeof split.amountSmallest === "number"
              ? split.currency.toLowerCase() === "btc"
                ? split.amountSmallest // BTC smallest unit IS sats
                : split.amountSmallest
              : split.currency.toLowerCase() === "btc"
                ? Math.ceil((split.amount ?? 0) * 100000000)
                : Math.ceil(split.amount ?? 0);
          const usdAmount = await satsToUSD(sellerSats);
          splitAmountSmallest = Math.ceil(usdAmount * 100);
        } else if (typeof split.amountSmallest === "number") {
          // Already in seller-currency smallest units — trust as-is.
          splitAmountSmallest = split.amountSmallest;
        } else {
          // Legacy path for callers still sending raw amounts.
          splitAmountSmallest = toSmallestUnit(
            split.amount ?? 0,
            stripeCurrency
          );
        }

        const { percent: donationPercent, cutSmallest: donationCutSmallest } =
          await resolveDonationCut(split.sellerPubkey, splitAmountSmallest);

        // Affiliate attribution is resolved SERVER-SIDE: the client may name
        // a code, but the rebate amount and affiliate/code IDs always come
        // from the stored, seller-scoped code row — never from the request.
        // Otherwise a caller could inflate the rebate or aim it at arbitrary
        // affiliate IDs and divert the seller's share.
        let affiliateRebateSmallest = 0;
        let affiliateBuyerDiscountSmallest = 0;
        let affiliateAccountId: string | null = null;
        let affiliateId: number | null = null;
        let affiliateCodeId: number | null = null;
        let affiliateCode: string | null = null;
        if (
          typeof split.affiliateCode === "string" &&
          split.affiliateCode.trim().length > 0
        ) {
          const found = await lookupAffiliateCode(
            split.sellerPubkey,
            split.affiliateCode.trim()
          );
          // Same validity, currency and self-referral rules as the
          // record-referral route. An unusable code simply means no
          // attribution — checkout must never fail over it.
          const currencyCompatible =
            !found?.currency ||
            found.currency.toLowerCase() === stripeCurrency.toLowerCase() ||
            (found.rebate_type !== "fixed" &&
              found.buyer_discount_type !== "fixed");
          if (
            found &&
            currencyCompatible &&
            (await isAffiliateCodeValid(found)) &&
            !isSelfReferral(
              split.sellerPubkey,
              found.affiliate?.affiliate_pubkey
            )
          ) {
            // The cart applies the buyer discount when constructing
            // amountSmallest, so splitAmountSmallest is ALREADY the
            // discounted net — compute the rebate on it directly.
            // Recomputing and subtracting the configured discount here
            // would double-count it and underpay the affiliate.
            affiliateRebateSmallest = Math.min(
              computeRebateSmallest(
                splitAmountSmallest,
                found.rebate_type,
                Number(found.rebate_value),
                stripeCurrency
              ),
              // The seller must keep at least one unit after the donation
              // cut and the rebate.
              Math.max(splitAmountSmallest - donationCutSmallest - 1, 0)
            );
            // Reconstruct the discount from the code config for referral
            // reporting only (gross = net + discount); it never affects the
            // charge or the payout. Percent reconstruction can be off by one
            // unit from cart-side rounding — a reporting tolerance, not
            // money movement.
            if (
              found.buyer_discount_type === "percent" &&
              Number(found.buyer_discount_value) > 0 &&
              Number(found.buyer_discount_value) < 100
            ) {
              const p = Number(found.buyer_discount_value);
              affiliateBuyerDiscountSmallest = Math.max(
                Math.round(splitAmountSmallest / (1 - p / 100)) -
                  splitAmountSmallest,
                0
              );
            } else if (found.buyer_discount_type === "fixed") {
              affiliateBuyerDiscountSmallest = Math.max(
                Math.floor(Number(found.buyer_discount_value) * 100),
                0
              );
            }
            affiliateAccountId = found.affiliate?.stripe_account_id ?? null;
            affiliateId = found.affiliate_id;
            affiliateCodeId = found.id;
            affiliateCode = found.code;
          }
        }

        splitDetails.push({
          pubkey: split.sellerPubkey,
          amountCents: splitAmountSmallest,
          accountId,
          donationPercent,
          donationCutSmallest,
          affiliateRebateSmallest,
          affiliateBuyerDiscountSmallest,
          affiliateAccountId,
          affiliateId,
          affiliateCodeId,
          affiliateCode,
        });
      }

      // The sum of per-seller smallest-unit subtotals IS the buyer charge.
      // The top-level `amount` from the request is informational only in
      // multi-merchant mode — using sum-of-splits as truth guarantees that
      // every transfer in process-transfers.ts can succeed (no
      // sum-exceeds-total mismatch) and that the buyer is charged exactly
      // what each seller is owed in aggregate.
      const splitsSum = splitDetails.reduce((s, d) => s + d.amountCents, 0);
      amountInSmallestUnit = Math.max(splitsSum + taxAddSmallest, 50);
    } else {
      amountInSmallestUnit = amountInSmallestUnit + taxAddSmallest;
      if (amountInSmallestUnit < 50) {
        amountInSmallestUnit = 50;
      }
    }

    if (isMultiMerchant) {
      const description = `${productTitle}${
        productDescription ? ` - ${productDescription}` : ""
      }`;

      // Stripe caps every metadata value at 500 chars — the full split
      // details JSON (donation + affiliate fields per seller) blows past that
      // with just TWO sellers, which used to fail every multi-seller card
      // checkout at PaymentIntent creation. The full details are persisted
      // server-side in the pending-payment record below (keyed by the
      // idempotency ref, carrying transferGroup) and echoed in this route's
      // response; the PaymentIntent metadata only needs the participating
      // seller pubkeys so card-payment verification (send-order-email) can
      // confirm membership. Omitted entirely for pathological carts whose
      // pubkey list alone would exceed the cap — verification then fails
      // closed rather than the checkout failing.
      const sellerSplitPubkeys = splitDetails.map((s) => s.pubkey).join(",");

      const paymentIntentParams: Stripe.PaymentIntentCreateParams = {
        amount: amountInSmallestUnit,
        currency: stripeCurrency,
        description,
        transfer_group: transferGroup,
        metadata: {
          ...safeMetadata,
          originalAmount: amount.toString(),
          originalCurrency: currency,
          isMultiMerchant: "true",
          transferGroup,
          // Server-owned authority marker: tells process-transfers an
          // authoritative split record MUST exist for this intent — a marked
          // intent with a missing/malformed record fails closed rather than
          // trusting the buyer's browser payload.
          [SPLIT_AUTHORITY_METADATA_KEY]: SPLIT_AUTHORITY_PENDING_RECORD,
          ...(taxAddSmallest > 0 && {
            salesTaxSmallest: taxAddSmallest.toString(),
          }),
          ...(taxAddSmallest > 0 &&
            taxCalculationId && {
              taxCalculationId: String(taxCalculationId),
            }),
          ...(sellerSplitPubkeys.length <= 490 && {
            sellerSplitPubkeys,
          }),
        },
        payment_method_types: ["card"],
      };

      if (safeCustomerEmail) {
        paymentIntentParams.receipt_email = safeCustomerEmail;
      }

      const intentRefMM = stableIdempotencyKey("mm", {
        amount: amountInSmallestUnit,
        currency: stripeCurrency,
        customerEmail: safeCustomerEmail ?? null,
        productTitle: productTitle ?? null,
        productDescription: productDescription ?? null,
        metadata: metadata ?? null,
        sellerSplits: sellerSplits ?? null,
        transferGroup,
      });
      // Fail closed: process-transfers pays out from this record (never the
      // buyer's browser payload), so a checkout whose authoritative split
      // record can't be durably saved must NOT become payable. Retrying the
      // request is safe — recordPendingPayment is INSERT ... ON CONFLICT DO
      // NOTHING on the stable intentRef.
      await recordPendingPayment({
        intentRef: intentRefMM,
        amount: amountInSmallestUnit,
        currency: stripeCurrency,
        // Full per-seller split details live here (JSONB, no size cap) as
        // the durable server-side record — the Stripe metadata above only
        // carries the compact pubkey list. Client metadata is stripped of
        // server-owned keys first so an injected sellerSplits/transferGroup
        // can never survive into the payout authority record.
        metadata: {
          ...stripServerOwnedMetadata(metadata),
          transferGroup,
          sellerSplits: splitDetails,
        },
      });
      // Multi-seller charges run on the platform account: register the
      // canonical platform host for Apple Pay there before the buyer's wallet
      // element initializes (never request-controlled hosts).
      const platformRegHost = await trustedRegistrationHost(req.headers?.host);
      if (platformRegHost) await registerApplePayDomain(platformRegHost);
      const paymentIntent = await withStripeRetry(() =>
        stripe.paymentIntents.create(paymentIntentParams, {
          idempotencyKey: intentRefMM,
        })
      );
      // Fail closed on the binding too: an unbound record can't be found by
      // process-transfers (it looks up by payment_intent_id), so this PI
      // must never reach the buyer as payable. The buyer sees an error and
      // retries; the same idempotency key re-uses both the row and the PI.
      await updatePendingPayment(intentRefMM, {
        paymentIntentId: paymentIntent.id,
        status: "created",
      });
      // Bind the buyer's checkout destination/product per seller to the
      // VERIFIED PaymentIntent id. Only the server-validated split sellers
      // may carry a context. Best-effort: a write failure only means the
      // auto-label purchase later skips (seller buys manually) — never a
      // wrong label, so it must not fail the checkout.
      try {
        await recordShippingCheckoutContexts(
          stripeCheckoutRef(paymentIntent.id),
          sanitizeCheckoutContexts(
            shippingContexts,
            new Set(splitDetails.map((s) => s.pubkey))
          )
        );
      } catch (e) {
        console.warn("recordShippingCheckoutContexts failed:", e);
      }

      return res.status(200).json({
        success: true,
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        connectedAccountId: undefined,
        isMultiMerchant: true,
        transferGroup,
        sellerSplits: splitDetails.map((s) => ({
          pubkey: s.pubkey,
          amountCents: s.amountCents,
          accountId: s.accountId,
          donationPercent: s.donationPercent,
          donationCutSmallest: s.donationCutSmallest,
          affiliateRebateSmallest: s.affiliateRebateSmallest,
          affiliateAccountId: s.affiliateAccountId,
          affiliateId: s.affiliateId,
          affiliateCodeId: s.affiliateCodeId,
          affiliateCode: s.affiliateCode,
        })),
      });
    }

    const sellerPubkey = metadata?.sellerPubkey;
    let connectedAccountId: string | null = null;

    // Reuse the single-seller account resolved above instead of a second DB
    // lookup for the same pubkey.
    if (singleSellerConnect && singleSellerConnect.charges_enabled) {
      connectedAccountId = singleSellerConnect.stripe_account_id;
    }

    const stripeOptions = connectedAccountId
      ? { stripeAccount: connectedAccountId }
      : undefined;

    // Single-merchant donation cut: only applied for direct charges on a
    // connected account (otherwise the funds are already on the platform).
    // Compute it on the PRE-TAX base (items + shipping): sales tax is collected
    // on the seller's behalf to remit, so the platform donation fee must never
    // skim it.
    const donationBaseSmallest = amountInSmallestUnit - taxAddSmallest;
    const { percent: singleDonationPercent, cutSmallest: singleDonationCut } =
      connectedAccountId
        ? await resolveDonationCut(sellerPubkey, donationBaseSmallest)
        : { percent: 0, cutSmallest: 0 };

    const description = `${productTitle}${
      productDescription ? ` - ${productDescription}` : ""
    }`;

    const paymentIntentParams: Stripe.PaymentIntentCreateParams = {
      amount: amountInSmallestUnit,
      currency: stripeCurrency,
      description,
      metadata: {
        ...safeMetadata,
        originalAmount: amount.toString(),
        originalCurrency: currency,
        ...(connectedAccountId && { connectedAccountId }),
        ...(singleDonationCut > 0 && {
          ssDonationPercent: singleDonationPercent.toString(),
          ssDonationCutSmallest: singleDonationCut.toString(),
          mmDonationPercent: singleDonationPercent.toString(),
          mmDonationCutSmallest: singleDonationCut.toString(),
        }),
        ...(taxAddSmallest > 0 && {
          salesTaxSmallest: taxAddSmallest.toString(),
        }),
        ...(taxAddSmallest > 0 &&
          taxCalculationId && {
            taxCalculationId: String(taxCalculationId),
          }),
      },
      payment_method_types: ["card"],
      ...(singleDonationCut > 0 && {
        application_fee_amount: singleDonationCut,
      }),
    };

    if (safeCustomerEmail) {
      paymentIntentParams.receipt_email = safeCustomerEmail;
    }

    const intentRef = stableIdempotencyKey("pi", {
      amount: amountInSmallestUnit,
      currency: stripeCurrency,
      customerEmail: safeCustomerEmail ?? null,
      productTitle: productTitle ?? null,
      productDescription: productDescription ?? null,
      metadata: metadata ?? null,
      connectedAccountId,
    });
    try {
      await recordPendingPayment({
        intentRef,
        amount: amountInSmallestUnit,
        currency: stripeCurrency,
        // Single-seller payments must never carry split authority: strip
        // server-owned keys so a caller can't plant a forged sellerSplits /
        // transferGroup into the row process-transfers later reads.
        metadata: {
          ...stripServerOwnedMetadata(metadata),
          connectedAccountId,
        },
      });
    } catch (e) {
      console.warn("recordPendingPayment failed:", e);
    }
    // Direct charge: Apple Pay domain registration must happen on the
    // connected account that owns this PaymentIntent (or the platform account
    // when unconnected), and only for the platform host or a verified custom
    // domain owned by THIS seller. Awaited so wallet eligibility is computed
    // after registration; cached per account+domain and fail-open.
    const sellerRegHost = await trustedRegistrationHost(
      req.headers?.host,
      sellerPubkey
    );
    if (sellerRegHost)
      await registerApplePayDomain(sellerRegHost, connectedAccountId);
    const paymentIntent = await withStripeRetry(() =>
      stripe.paymentIntents.create(paymentIntentParams, {
        ...(stripeOptions ?? {}),
        idempotencyKey: intentRef,
      })
    );
    try {
      await updatePendingPayment(intentRef, {
        paymentIntentId: paymentIntent.id,
        status: "created",
      });
    } catch (e) {
      console.warn("updatePendingPayment failed:", e);
    }
    // Same checkout-time shipping binding as the multi-merchant branch above.
    // The direct charge lands on the account of the metadata seller(s), so
    // only they may carry a context for this intent.
    try {
      const allowedSellers = new Set(
        (typeof sellerPubkey === "string" ? sellerPubkey : "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      );
      await recordShippingCheckoutContexts(
        stripeCheckoutRef(paymentIntent.id),
        sanitizeCheckoutContexts(shippingContexts, allowedSellers)
      );
    } catch (e) {
      console.warn("recordShippingCheckoutContexts failed:", e);
    }

    return res.status(200).json({
      success: true,
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      connectedAccountId: connectedAccountId || undefined,
    });
  } catch (error) {
    console.error("Stripe PaymentIntent creation error:", error);
    const rateError = isExchangeRateError(error);
    return res.status(rateError ? 503 : 500).json({
      error: "Failed to create payment intent",
      ...(rateError && { code: EXCHANGE_RATE_ERROR_CODE }),
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
