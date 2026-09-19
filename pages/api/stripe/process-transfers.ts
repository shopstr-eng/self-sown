import type { NextApiRequest, NextApiResponse } from "next";
import Stripe from "stripe";
import { getStripeConnectAccount } from "@/utils/db/db-service";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2025-09-30.clover",
});

// The compact-metadata era began when full splits moved out of PI metadata
// into stripe_pending_payments (commit 01043f1d). From then until
// authority-key stripping shipped, caller-supplied metadata.sellerSplits
// survived into the PI verbatim — so a recordless PI's metadata splits are
// trustworthy ONLY when the intent predates that change, when
// create-payment-intent itself stamped the split JSON. `created` is set by
// Stripe and cannot be forged by the caller.
const LEGACY_SPLIT_METADATA_MAX_CREATED = 1789606037;

interface SellerSplit {
  sellerPubkey: string;
  amountCents: number;
  accountId?: string;
  donationPercent?: number;
  donationCutSmallest?: number;
  affiliateRebateSmallest?: number;
  // Buyer discount the cart already applied to amountCents, reconstructed
  // from the code config at creation time (referral reporting only).
  affiliateBuyerDiscountSmallest?: number;
  affiliateAccountId?: string | null;
  affiliateId?: number | null;
  affiliateCodeId?: number | null;
  affiliateCode?: string | null;
}

/**
 * Split payloads appear with two pubkey field names depending on the source:
 * the create-payment-intent response echo and the persisted pending-payment
 * record use `pubkey`, while hand-rolled/legacy callers use `sellerPubkey`.
 * Accept both and normalize to the internal SellerSplit shape. Returns null
 * when any entry is unusable (missing pubkey or a non-positive amount).
 */
function normalizeSplit(raw: unknown): SellerSplit | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const sellerPubkey =
    typeof r.sellerPubkey === "string"
      ? r.sellerPubkey
      : typeof r.pubkey === "string"
        ? r.pubkey
        : null;
  const amountCents =
    typeof r.amountCents === "number" && Number.isFinite(r.amountCents)
      ? r.amountCents
      : null;
  if (!sellerPubkey || amountCents === null || amountCents <= 0) return null;
  return {
    sellerPubkey,
    amountCents,
    accountId: typeof r.accountId === "string" ? r.accountId : undefined,
    donationPercent:
      typeof r.donationPercent === "number" ? r.donationPercent : undefined,
    donationCutSmallest:
      typeof r.donationCutSmallest === "number"
        ? r.donationCutSmallest
        : undefined,
    affiliateRebateSmallest:
      typeof r.affiliateRebateSmallest === "number"
        ? r.affiliateRebateSmallest
        : undefined,
    affiliateBuyerDiscountSmallest:
      typeof r.affiliateBuyerDiscountSmallest === "number"
        ? r.affiliateBuyerDiscountSmallest
        : undefined,
    affiliateAccountId:
      typeof r.affiliateAccountId === "string" ? r.affiliateAccountId : null,
    affiliateId: typeof r.affiliateId === "number" ? r.affiliateId : null,
    affiliateCodeId:
      typeof r.affiliateCodeId === "number" ? r.affiliateCodeId : null,
    affiliateCode:
      typeof r.affiliateCode === "string" ? r.affiliateCode : null,
  };
}

/**
 * Cross-check the browser-supplied splits against the authoritative server
 * record. Only the money fields matter: the participating seller set and each
 * seller's gross amount. Any divergence means the payload was tampered with.
 */
function splitsMatchRecord(
  clientSplits: SellerSplit[],
  recordSplits: SellerSplit[]
): boolean {
  if (clientSplits.length !== recordSplits.length) return false;
  const byPubkey = new Map(recordSplits.map((s) => [s.sellerPubkey, s]));
  return clientSplits.every((c) => {
    const rec = byPubkey.get(c.sellerPubkey);
    return rec !== undefined && rec.amountCents === c.amountCents;
  });
}

import { applyRateLimit } from "@/utils/rate-limit";
import {
  withStripeRetry,
  StripeOperationError,
} from "@/utils/stripe/retry-service";
import {
  getPendingPaymentByIntentId,
  SPLIT_AUTHORITY_METADATA_KEY,
  SPLIT_AUTHORITY_PENDING_RECORD,
} from "@/utils/stripe/pending-payments";
import {
  claimPayout,
  completePayoutClaim,
  releasePayoutClaim,
  PayoutClaimConflictError,
} from "@/utils/stripe/payout-claims";
import {
  resolveDonationCut,
  computeDonationCutSmallest,
} from "@/utils/stripe/donation";
import {
  affiliateFixedValueToSmallest,
  computeRebateSmallest,
  isAffiliateCodeValid,
  isSelfReferral,
  lookupAffiliateCode,
  migrateReferralOrderId,
  recordReferral,
} from "@/utils/db/affiliates";

// Rate limit: per-IP cap to bound abuse of payment endpoints.
const RATE_LIMIT = { limit: 30, windowMs: 60000 };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await applyRateLimit(req, res, "stripe-process-transfers", RATE_LIMIT)))
    return;

  try {
    const {
      paymentIntentId,
      sellerSplits: rawClientSplits,
      transferGroup,
    } = req.body as {
      paymentIntentId: string;
      sellerSplits?: unknown[];
      transferGroup: string;
    };

    if (!paymentIntentId) {
      return res.status(400).json({ error: "paymentIntentId is required" });
    }
    if (!transferGroup) {
      return res.status(400).json({ error: "transferGroup is required" });
    }

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (paymentIntent.status !== "succeeded") {
      return res.status(400).json({
        error: `Payment has not succeeded yet. Status: ${paymentIntent.status}`,
      });
    }

    // The top-level transfer_group is set by the server at PaymentIntent
    // creation (multi-merchant branch only) and can NOT be influenced through
    // client-supplied metadata — it is the unforgeable proof that this intent
    // is a server-created multi-seller charge. Without it there is nothing
    // to pay out here, no matter what any database row or metadata key says.
    const piTransferGroup =
      typeof paymentIntent.transfer_group === "string" &&
      paymentIntent.transfer_group.length > 0
        ? paymentIntent.transfer_group
        : null;
    if (!piTransferGroup) {
      return res
        .status(400)
        .json({ error: "Not a multi-seller payment intent" });
    }
    if (piTransferGroup !== transferGroup) {
      return res.status(400).json({
        error: "transferGroup does not match the payment intent",
      });
    }

    // Resolve the splits from authoritative SERVER-STAMPED sources only; the
    // buyer's browser payload is never a source of truth (it is at most
    // cross-checked below). Sources, in order:
    //   1. The pending-payment record persisted by create-payment-intent
    //      (metadata.sellerSplits, keyed by payment_intent_id).
    //   2. Legacy: the split-details JSON create-payment-intent stamped into
    //      the PaymentIntent's own metadata before record persistence
    //      existed (Stripe metadata is server-written at creation).
    // A DB outage throws here (fail closed). Anything unrecognized fails
    // closed too — process-transfers never trusts the request body.
    const pendingPayment = await getPendingPaymentByIntentId(paymentIntentId);
    const piMetadata: Record<string, string> = paymentIntent.metadata ?? {};

    let sellerSplits: SellerSplit[] | null = null;
    let authoritativeTransferGroup: string | null = null;

    if (pendingPayment) {
      const recordMetadata = pendingPayment.metadata ?? {};
      if (Array.isArray(recordMetadata.sellerSplits)) {
        const rawRecordSplits = recordMetadata.sellerSplits;
        const normalized = rawRecordSplits.map(normalizeSplit);
        if (
          rawRecordSplits.length === 0 ||
          normalized.some((s) => s === null)
        ) {
          // A record exists but at least one stored split entry is unusable
          // (missing pubkey, non-positive amount). Partially paying a
          // malformed authoritative record would mis-pay the remaining
          // sellers — fail closed for ops to resolve.
          return res.status(409).json({
            error:
              "Authoritative split record for this payment is malformed; refusing to process transfers",
          });
        }
        // The record must be consistent with the PaymentIntent it claims to
        // govern: same server-stamped transfer group, same currency, and a
        // split total no larger than what the buyer was actually charged.
        // Anything less proves nothing about who created the row.
        const recordTransferGroup =
          typeof recordMetadata.transferGroup === "string"
            ? recordMetadata.transferGroup
            : null;
        if (recordTransferGroup !== piTransferGroup) {
          return res.status(409).json({
            error:
              "Split record transfer group does not match the payment intent; refusing to process transfers",
          });
        }
        if (pendingPayment.currency !== paymentIntent.currency) {
          return res.status(409).json({
            error:
              "Split record currency does not match the payment intent; refusing to process transfers",
          });
        }
        const recordTotal = (normalized as SellerSplit[]).reduce(
          (sum, s) => sum + s.amountCents,
          0
        );
        if (recordTotal > paymentIntent.amount) {
          return res.status(409).json({
            error:
              "Split record total exceeds the amount paid; refusing to process transfers",
          });
        }
        sellerSplits = normalized as SellerSplit[];
        authoritativeTransferGroup = recordTransferGroup;
      }
    }

    if (!sellerSplits && typeof piMetadata.sellerSplits === "string") {
      // Legacy intents carry the full split details in PI metadata —
      // trustworthy only for the pre-compact era, when
      // create-payment-intent stamped that JSON itself. During the
      // transitional era (splits moved to the pending-payment record but
      // authority keys not yet stripped from caller metadata) an attacker
      // could inject sellerSplits into a recordless PI whose transfer_group
      // is genuinely server-generated. Fail closed for anything not
      // provably from the stamped era.
      if (
        typeof paymentIntent.created !== "number" ||
        paymentIntent.created >= LEGACY_SPLIT_METADATA_MAX_CREATED
      ) {
        return res.status(409).json({
          error:
            "Split metadata is not provably server-stamped for this payment; refusing to process transfers",
        });
      }
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(piMetadata.sellerSplits);
      } catch {
        parsed = null;
      }
      const rawMetaSplits = Array.isArray(parsed) ? parsed : null;
      const normalized = rawMetaSplits?.map(normalizeSplit) ?? null;
      if (
        !rawMetaSplits ||
        rawMetaSplits.length === 0 ||
        !normalized ||
        normalized.some((s) => s === null)
      ) {
        return res.status(409).json({
          error:
            "Authoritative split metadata for this payment is malformed; refusing to process transfers",
        });
      }
      if (piMetadata.transferGroup !== piTransferGroup) {
        return res.status(409).json({
          error:
            "Stamped split metadata transfer group does not match the payment intent; refusing to process transfers",
        });
      }
      sellerSplits = normalized as SellerSplit[];
      authoritativeTransferGroup = piMetadata.transferGroup;
      // Defense in depth: the server-stamped totals must never exceed what
      // the buyer was actually charged.
      const authoritativeTotal = sellerSplits.reduce(
        (sum, s) => sum + s.amountCents,
        0
      );
      if (authoritativeTotal > paymentIntent.amount) {
        return res.status(409).json({
          error:
            "Authoritative split total exceeds the amount paid; refusing to process transfers",
        });
      }
      // Defense in depth: when the compact server-owned pubkey list is
      // present, every split seller must appear in it.
      if (typeof piMetadata.sellerSplitPubkeys === "string") {
        const allowedPubkeys = new Set(
          piMetadata.sellerSplitPubkeys.split(",").map((p) => p.trim())
        );
        if (sellerSplits.some((s) => !allowedPubkeys.has(s.sellerPubkey))) {
          return res.status(409).json({
            error:
              "Split metadata names a seller outside the stamped seller set; refusing to process transfers",
          });
        }
      }
    }

    if (!sellerSplits) {
      // Recognized multi-seller intents (authority marker, multi-merchant
      // flag, or server-stamped transfer group) MUST have a usable
      // authoritative record — anything else is an anomaly to fail closed
      // on. Unrecognized (single-seller) intents were never payable here.
      const recognizedMultiMerchant =
        piMetadata[SPLIT_AUTHORITY_METADATA_KEY] ===
          SPLIT_AUTHORITY_PENDING_RECORD ||
        piMetadata.isMultiMerchant === "true" ||
        typeof piMetadata.sellerSplitPubkeys === "string" ||
        typeof piMetadata.transferGroup === "string";
      if (recognizedMultiMerchant) {
        return res.status(409).json({
          error:
            "Authoritative split record is missing for this payment; refusing to process transfers",
        });
      }
      return res
        .status(400)
        .json({ error: "Not a multi-seller payment intent" });
    }

    // Payout claims are keyed by (paymentIntentId, sellerPubkey), so a
    // duplicated seller in the authoritative set would collide: the first
    // entry would transfer and the rest would be misreported as paid while
    // the buyer was charged the full split sum. Fail closed.
    const seenSplitPubkeys = new Set<string>();
    for (const s of sellerSplits) {
      if (seenSplitPubkeys.has(s.sellerPubkey)) {
        return res.status(409).json({
          error:
            "Authoritative split record contains a duplicate seller; refusing to process transfers",
        });
      }
      seenSplitPubkeys.add(s.sellerPubkey);
    }

    // Every authoritative source was already required to match the intent's
    // own server-set transfer group (and the request was checked against it
    // above), so this is what the Stripe transfers are stamped with.
    const effectiveTransferGroup = authoritativeTransferGroup ?? piTransferGroup;

    // Cross-check the client payload when the caller supplied one: the
    // seller set and every gross amount must match the authority exactly.
    if (Array.isArray(rawClientSplits) && rawClientSplits.length > 0) {
      const clientSplits = rawClientSplits.map(normalizeSplit);
      if (
        clientSplits.some((s) => s === null) ||
        !splitsMatchRecord(clientSplits as SellerSplit[], sellerSplits)
      ) {
        return res.status(400).json({
          error:
            "sellerSplits do not match the server-side record for this payment",
        });
      }
    }

    const transferCurrency = paymentIntent.currency;
    // Lazily fetched transfers already recorded at Stripe for this transfer
    // group. A freshly-created claim proves nothing about PRE-claim history:
    // the intent may have been paid out before claims existed, or by an
    // attempt whose completion write failed after the transfer succeeded.
    // The first claimed attempt reconciles against this list and adopts any
    // existing transfer instead of double-paying.
    let groupTransfers: Stripe.Transfer[] | null = null;
    const getGroupTransfers = async (): Promise<Stripe.Transfer[]> => {
      if (groupTransfers === null) {
        // Page through the FULL group history — a historical payout outside
        // the first page must still be found before concluding none exists.
        // Transfer groups are per-cart (tiny); the page cap only guards
        // against pathological cases.
        const all: Stripe.Transfer[] = [];
        let startingAfter: string | undefined;
        for (let page = 0; ; page++) {
          const resp = await stripe.transfers.list({
            transfer_group: effectiveTransferGroup,
            limit: 100,
            ...(startingAfter ? { starting_after: startingAfter } : {}),
          });
          all.push(...resp.data);
          if (!resp.has_more) break;
          const last = resp.data[resp.data.length - 1];
          if (!last) break;
          startingAfter = last.id;
          if (page >= 19) {
            // The defensive page cap was hit with more history remaining —
            // the view is incomplete, so FAIL CLOSED (reconciliation error,
            // claim released) rather than deciding "no prior payout" from a
            // partial list and duplicating one.
            throw new Error(
              "Transfer group history exceeds reconciliation page cap"
            );
          }
        }
        // Group integrity: an identity-bearing transfer naming THIS payment
        // but a seller outside the authoritative split set is exactly the
        // shape of a payout created through the former browser-forged
        // payload. Paying the authoritative splits on top of it would push
        // total transfers past the charge — fail closed for ops before any
        // transfer is created.
        const authoritativePubkeys = new Set(
          sellerSplits.map((s) => s.sellerPubkey)
        );
        for (const t of all) {
          const md = t.metadata ?? {};
          if (
            md.paymentIntentId === paymentIntentId &&
            typeof md.sellerPubkey === "string" &&
            !authoritativePubkeys.has(md.sellerPubkey)
          ) {
            throw new Error(
              `Transfer ${t.id} names this payment but an unknown seller`
            );
          }
        }
        groupTransfers = all;
      }
      return groupTransfers;
    };
    // Adoption is one-to-one: a pre-existing transfer settles exactly one
    // seller's payout. Two splits can legitimately share a destination
    // account (and even an amount), so a matched transfer is consumed and
    // can never be adopted by a second split.
    const consumedTransferIds = new Set<string>();
    // Referral idempotency is keyed on the PaymentIntent id — never the
    // client-writable metadata.orderId, which a buyer could forge to collide
    // with another order's referral dedup or to dodge the refund webhook's
    // reversal.
    const orderId = paymentIntentId;
    // Referrals recorded before the PI-id keying live under the
    // client-supplied metadata order id; kept only so tryAccrueAffiliate can
    // re-key those rows onto the canonical id before accruing.
    const legacyOrderId =
      paymentIntent.metadata &&
      typeof paymentIntent.metadata.orderId === "string" &&
      paymentIntent.metadata.orderId
        ? paymentIntent.metadata.orderId
        : null;

    const results: {
      sellerPubkey: string;
      transferId?: string;
      error?: string;
      skipped?: boolean;
      donationCutSmallest?: number;
      transferredAmount?: number;
      affiliateTransferId?: string;
      affiliateRebateSmallest?: number;
      affiliateAccrued?: boolean;
      affiliateError?: string;
    }[] = [];

    // Affiliate accrual is idempotent (recordReferral dedupes per
    // order/seller/rail) but NOT transactional with the transfer or the
    // claim completion — a crash between them leaves the rebate withheld
    // from the seller but never credited. So EVERY path that reports a
    // seller paid (fresh transfer, completed-claim replay, adopted
    // historical transfer) re-attempts the accrual. A failure is reported,
    // never fatal: the payout already happened.
    const tryAccrueAffiliate = async (
      split: (typeof sellerSplits)[number],
      accrual: {
        rebateSmallest: number;
        buyerDiscountSmallest: number;
        affiliateId: number | null;
        affiliateCodeId: number | null;
      },
      result: (typeof results)[number]
    ): Promise<void> => {
      if (
        accrual.rebateSmallest <= 0 ||
        !accrual.affiliateId ||
        !accrual.affiliateCodeId
      )
        return;
      try {
        // Rollout migration: referrals recorded before this route keyed on
        // the PaymentIntent id live under the client-supplied metadata order
        // id. Re-key them onto the PI id FIRST so the insert below dedups
        // against them — otherwise replaying an already-paid intent (e.g. a
        // historical-transfer adoption) double-accrues the rebate.
        // Only intents created before the authority marker existed can
        // genuinely carry order-keyed referral rows. The marker is
        // server-stamped at creation and stripped from caller metadata, so
        // on a marked (current) intent metadata.orderId is
        // caller-controlled and must never authorize re-keying another
        // order's referral.
        if (
          legacyOrderId &&
          legacyOrderId !== orderId &&
          piMetadata[SPLIT_AUTHORITY_METADATA_KEY] !==
            SPLIT_AUTHORITY_PENDING_RECORD
        ) {
          await migrateReferralOrderId({
            legacyOrderId,
            newOrderId: orderId,
            codeId: accrual.affiliateCodeId,
            sellerPubkey: split.sellerPubkey,
          });
        }
        await recordReferral({
          affiliateId: accrual.affiliateId,
          codeId: accrual.affiliateCodeId,
          sellerPubkey: split.sellerPubkey,
          orderId,
          paymentRail: "stripe",
          grossSubtotalSmallest:
            split.amountCents + accrual.buyerDiscountSmallest,
          buyerDiscountSmallest: accrual.buyerDiscountSmallest,
          rebateSmallest: accrual.rebateSmallest,
          currency: transferCurrency,
          initialStatus: "pending",
          realtimeTransferRef: null,
        });
        result.affiliateAccrued = true;
        result.affiliateRebateSmallest = accrual.rebateSmallest;
      } catch (e) {
        result.affiliateError =
          e instanceof Error ? e.message : "Affiliate referral record failed";
      }
    };

    for (const split of sellerSplits) {
      const isPlatformAccount =
        split.sellerPubkey === process.env.NEXT_PUBLIC_SELF_SOWN_PK;

      if (isPlatformAccount) {
        results.push({
          sellerPubkey: split.sellerPubkey,
          skipped: true,
        });
        continue;
      }

      let accountId = split.accountId;
      if (!accountId) {
        const connectAccount = await getStripeConnectAccount(
          split.sellerPubkey
        );
        if (!connectAccount || !connectAccount.charges_enabled) {
          results.push({
            sellerPubkey: split.sellerPubkey,
            error: "Vendor does not have Stripe enabled",
          });
          continue;
        }
        accountId = connectAccount.stripe_account_id;
      }

      // Resolve the donation cut for this seller. Prefer values that the
      // create-payment-intent endpoint already computed and embedded in the
      // split (so on-chain math matches what was charged); fall back to a
      // fresh profile lookup so older clients still get parity.
      let donationCut = 0;
      let donationPercent = 0;
      if (
        typeof split.donationCutSmallest === "number" &&
        split.donationCutSmallest > 0
      ) {
        donationCut = Math.min(
          split.donationCutSmallest,
          split.amountCents - 1
        );
        donationPercent = split.donationPercent ?? 0;
      } else if (
        typeof split.donationPercent === "number" &&
        split.donationPercent > 0
      ) {
        donationPercent = split.donationPercent;
        donationCut = computeDonationCutSmallest(
          split.amountCents,
          donationPercent
        );
      } else {
        const resolved = await resolveDonationCut(
          split.sellerPubkey,
          split.amountCents
        );
        donationPercent = resolved.percent;
        donationCut = resolved.cutSmallest;
      }

      // Affiliate amounts/IDs in the split record may predate server-side
      // resolution (a staged intent created under the former
      // browser-authoritative route) — NEVER trust them. Re-resolve from the
      // code string against the seller-scoped code row and recompute the
      // rebate from the stored config. An unresolvable or invalid code means
      // NO rebate deduction and no accrual: the seller keeps the full amount
      // (the fail-safe direction).
      let affiliateRebate = 0;
      let affiliateBuyerDiscount = 0;
      let affiliateId: number | null = null;
      let affiliateCodeId: number | null = null;
      if (typeof split.affiliateCode === "string" && split.affiliateCode) {
        const foundCode = await lookupAffiliateCode(
          split.sellerPubkey,
          split.affiliateCode
        );
        const affiliateCurrencyCompatible =
          !foundCode?.currency ||
          foundCode.currency.toLowerCase() ===
            transferCurrency.toLowerCase() ||
          (foundCode.rebate_type !== "fixed" &&
            foundCode.buyer_discount_type !== "fixed");
        if (
          foundCode &&
          affiliateCurrencyCompatible &&
          (await isAffiliateCodeValid(foundCode)) &&
          !isSelfReferral(
            split.sellerPubkey,
            foundCode.affiliate?.affiliate_pubkey
          )
        ) {
          affiliateRebate = Math.min(
            computeRebateSmallest(
              split.amountCents,
              foundCode.rebate_type,
              Number(foundCode.rebate_value),
              transferCurrency
            ),
            // The seller always keeps at least 1 unit after the donation
            // cut and the rebate.
            Math.max(split.amountCents - donationCut - 1, 0)
          );
          // Reconstruct the buyer discount from the code config for
          // consistent referral reporting (gross = net + discount); the
          // record's copy is not trusted either.
          if (
            foundCode.buyer_discount_type === "percent" &&
            Number(foundCode.buyer_discount_value) > 0 &&
            Number(foundCode.buyer_discount_value) < 100
          ) {
            const p = Number(foundCode.buyer_discount_value);
            affiliateBuyerDiscount = Math.max(
              Math.round(split.amountCents / (1 - p / 100)) - split.amountCents,
              0
            );
          } else if (foundCode.buyer_discount_type === "fixed") {
            affiliateBuyerDiscount = affiliateFixedValueToSmallest(
              Number(foundCode.buyer_discount_value),
              transferCurrency
            );
          }
          affiliateId = foundCode.affiliate_id;
          affiliateCodeId = foundCode.id;
        }
      }
      const accrual = {
        rebateSmallest: affiliateRebate,
        buyerDiscountSmallest: affiliateBuyerDiscount,
        affiliateId,
        affiliateCodeId,
      };

      const transferAmount = Math.max(
        split.amountCents - donationCut - affiliateRebate,
        0
      );
      if (transferAmount <= 0) {
        results.push({
          sellerPubkey: split.sellerPubkey,
          error:
            "Computed transfer amount is zero after donation cut; skipping",
          donationCutSmallest: donationCut,
          transferredAmount: 0,
        });
        continue;
      }

      // Server-side payout claim: one durable row per (paymentIntentId,
      // sellerPubkey) — both server-resolved, never client-controlled — so a
      // replayed request (buyer closed the tab, ops retry, attacker probing
      // with fresh pubkeys) cannot create a second transfer once the first
      // succeeded. Stripe's own idempotency keys are only guaranteed for
      // ~24h; the claim is what makes replays safe beyond that window.
      const claim = await claimPayout(paymentIntentId, split.sellerPubkey);
      if (!claim.created) {
        if (claim.transferId) {
          // Already paid on a previous call — the transfer is a no-op, but
          // the affiliate accrual is NOT: claim completion and
          // recordReferral are not transactional, so a crash between them
          // leaves the rebate withheld from the seller but never credited.
          // Re-attempt the idempotent accrual on every replay.
          const result: (typeof results)[number] = {
            sellerPubkey: split.sellerPubkey,
            transferId: claim.transferId,
            skipped: true,
          };
          await tryAccrueAffiliate(split, accrual, result);
          results.push(result);
          continue;
        }
        // A claim exists without a recorded transfer: a previous attempt
        // crashed between the Stripe call and the claim completion (or one
        // is in flight right now). Retrying could double-pay once Stripe's
        // ~24h idempotency window lapses, so this fails closed for ops
        // reconciliation instead of transferring again.
        results.push({
          sellerPubkey: split.sellerPubkey,
          error:
            "Payout claim is unresolved; manual reconciliation required",
        });
        continue;
      }

      // Reconcile pre-claim history before paying (see getGroupTransfers).
      // If the reconciliation lookup itself fails, no transfer was attempted
      // — the fresh claim is safe to release so a later retry can reconcile.
      let reconciled = false;
      try {
        const pool = (await getGroupTransfers()).filter(
          (t) => !consumedTransferIds.has(t.id)
        );
        const hasIdentity = (t: Stripe.Transfer): boolean => {
          const md = t.metadata ?? {};
          return (
            typeof md.paymentIntentId === "string" ||
            typeof md.sellerPubkey === "string"
          );
        };
        const namesThisSeller = (t: Stripe.Transfer): boolean =>
          t.metadata?.paymentIntentId === paymentIntentId &&
          t.metadata?.sellerPubkey === split.sellerPubkey;
        const shapeMatches = (t: Stripe.Transfer): boolean =>
          typeof t.destination === "string" &&
          t.destination === accountId &&
          t.amount === transferAmount &&
          t.currency === transferCurrency;

        // An identity-bearing transfer naming THIS payment+seller is strong
        // evidence about this payout — but that metadata was written by the
        // formerly browser-authoritative route, so it is only adoptable when
        // its destination, amount and currency ALSO match the authoritative
        // split. A contradiction is a tampering anomaly: fail closed for
        // ops instead of recording the wrong transfer as this seller's
        // payout (or paying again on top of it).
        const conflictingIdentity = pool.some(
          (t) => hasIdentity(t) && namesThisSeller(t) && !shapeMatches(t)
        );
        if (conflictingIdentity) {
          results.push({
            sellerPubkey: split.sellerPubkey,
            error:
              "Conflicting historical transfer for this payout; manual reconciliation required",
          });
          continue;
        }

        // Adoption candidates: identity matches first (strongest evidence),
        // then metadata-less legacy transfers matching on shape. A transfer
        // that names a DIFFERENT seller is never a candidate for this one.
        // Every adoption is reserved atomically and globally one-to-one
        // (unique index on transfer_id); on a reservation conflict — another
        // claim already owns that transfer — move on to the NEXT candidate
        // instead of paying while a valid historical transfer remains.
        const candidates = [
          ...pool.filter((t) => hasIdentity(t) && namesThisSeller(t)),
          ...pool.filter((t) => !hasIdentity(t) && shapeMatches(t)),
        ];
        for (const candidate of candidates) {
          consumedTransferIds.add(candidate.id);
          try {
            await completePayoutClaim(
              paymentIntentId,
              split.sellerPubkey,
              candidate.id
            );
          } catch (adoptError) {
            if (adoptError instanceof PayoutClaimConflictError) {
              console.warn(
                `Transfer ${candidate.id} already recorded on another claim; trying next reconciliation candidate for ${paymentIntentId}/${split.sellerPubkey}`
              );
              continue;
            }
            throw adoptError;
          }
          const result: (typeof results)[number] = {
            sellerPubkey: split.sellerPubkey,
            transferId: candidate.id,
            skipped: true,
          };
          await tryAccrueAffiliate(split, accrual, result);
          results.push(result);
          reconciled = true;
          break;
        }
      } catch (reconError) {
        console.error(
          `Payout reconciliation failed for ${paymentIntentId}/${split.sellerPubkey}:`,
          reconError
        );
        try {
          await releasePayoutClaim(paymentIntentId, split.sellerPubkey);
        } catch (releaseError) {
          console.error(
            `Failed to release payout claim for ${paymentIntentId}/${split.sellerPubkey}:`,
            releaseError
          );
        }
        results.push({
          sellerPubkey: split.sellerPubkey,
          error: "Payout reconciliation failed; retry later",
        });
        continue;
      }
      if (reconciled) continue;

      try {
        const transfer = await withStripeRetry(() =>
          stripe.transfers.create(
            {
              amount: transferAmount,
              currency: transferCurrency,
              destination: accountId,
              transfer_group: effectiveTransferGroup,
              metadata: {
                paymentIntentId,
                sellerPubkey: split.sellerPubkey,
                grossAmount: split.amountCents.toString(),
                ssDonationPercent: donationPercent.toString(),
                ssDonationCutSmallest: donationCut.toString(),
                mmDonationPercent: donationPercent.toString(),
                mmDonationCutSmallest: donationCut.toString(),
              },
            },
            {
              idempotencyKey: `transfer-${paymentIntentId}-${split.sellerPubkey}`,
            }
          )
        );

        try {
          await completePayoutClaim(
            paymentIntentId,
            split.sellerPubkey,
            transfer.id
          );
        } catch (claimError) {
          // The transfer succeeded at Stripe. Do NOT release the claim on
          // this path — a released claim would let a replay double-pay.
          // The retained claim blocks naive replays; ops can reconcile via
          // the deterministic Stripe idempotency key.
          console.error(
            `Payout claim completion failed for ${paymentIntentId}/${split.sellerPubkey}; claim retained`,
            claimError
          );
        }

        const result: (typeof results)[number] = {
          sellerPubkey: split.sellerPubkey,
          transferId: transfer.id,
          donationCutSmallest: donationCut,
          transferredAmount: transferAmount,
          affiliateRebateSmallest: affiliateRebate,
        };

        // Real-time affiliate transfers were removed; the rebate accrues
        // server-side via the idempotent referral write (see
        // tryAccrueAffiliate — also re-attempted on replays).
        await tryAccrueAffiliate(split, accrual, result);

        results.push(result);
      } catch (transferError) {
        console.error(
          `Transfer failed for seller ${split.sellerPubkey}:`,
          transferError
        );
        // withStripeRetry wraps the provider error in a StripeOperationError;
        // the Stripe error (with its `type` discriminator) is the cause.
        const underlying =
          transferError instanceof StripeOperationError && transferError.cause
            ? transferError.cause
            : transferError;
        const stripeType =
          underlying && typeof underlying === "object"
            ? (underlying as { type?: string }).type
            : undefined;
        if (stripeType === "StripeInvalidRequestError") {
          // Stripe rejected the request without creating a transfer
          // (validation, insufficient balance, bad destination) — release
          // the claim so a later retry can pay this seller (mirrors the
          // webhook claim-release rule).
          try {
            await releasePayoutClaim(paymentIntentId, split.sellerPubkey);
          } catch (releaseError) {
            console.error(
              `Failed to release payout claim for ${paymentIntentId}/${split.sellerPubkey}:`,
              releaseError
            );
          }
        } else {
          // Timeouts, 5xx and network failures are INDETERMINATE: Stripe may
          // have created the transfer even though every response was lost,
          // and its ~24h idempotency window may lapse before the next retry.
          // Keep the claim — the unresolved-claim path then fails closed
          // for reconciliation instead of risking a duplicate payout.
          console.error(
            `Payout claim for ${paymentIntentId}/${split.sellerPubkey} retained after ambiguous transfer outcome (${stripeType ?? "unknown"})`
          );
        }
        results.push({
          sellerPubkey: split.sellerPubkey,
          error:
            transferError instanceof Error
              ? transferError.message
              : "Transfer failed",
        });
      }
    }

    const allSucceeded = results.every((r) => r.transferId || r.skipped);

    return res.status(200).json({
      success: allSucceeded,
      results,
    });
  } catch (error) {
    console.error("Process transfers error:", error);
    return res.status(500).json({
      error: "Failed to process transfers",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
