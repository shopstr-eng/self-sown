import type { NextApiRequest, NextApiResponse } from "next";
import Stripe from "stripe";
import {
  getStripeConnectAccount,
  createSubscription,
} from "@/utils/db/db-service";
import {
  ZERO_DECIMAL_CURRENCIES,
  isCrypto as isCryptoCurrency,
  convertToSmallestUnit,
  isExchangeRateError,
  EXCHANGE_RATE_ERROR_CODE,
} from "@/utils/stripe/currency";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2025-09-30.clover",
});
import { applyRateLimit } from "@/utils/rate-limit";
import {
  withStripeRetry,
  stableIdempotencyKey,
} from "@/utils/stripe/retry-service";
import {
  getSellerDonationPercent,
  isPlatformPubkey,
  computeDonationCutSmallest,
} from "@/utils/stripe/donation";
import {
  registerApplePayDomain,
  trustedRegistrationHost,
} from "@/utils/stripe/apple-pay";
import { resolveSubscriptionPaymentIntent } from "@/utils/stripe/subscription-payment-intent";
import {
  recordPendingPayment,
  reclaimPendingPayment,
  updatePendingPayment,
  getPendingPayment,
  SPLIT_AUTHORITY_METADATA_KEY,
  SPLIT_AUTHORITY_PENDING_RECORD,
  SUBSCRIPTION_ATTEMPT_TRACKED_METADATA_KEY,
  SUBSCRIPTION_CREATE_ATTEMPTED_METADATA_KEY,
  SUBSCRIPTION_CREATE_FAILED_METADATA_KEY,
} from "@/utils/stripe/pending-payments";

const FREQUENCY_TO_INTERVAL: Record<
  string,
  {
    interval: Stripe.PriceCreateParams.Recurring.Interval;
    interval_count: number;
  }
> = {
  weekly: { interval: "week", interval_count: 1 },
  every_2_weeks: { interval: "week", interval_count: 2 },
  monthly: { interval: "month", interval_count: 1 },
  every_2_months: { interval: "month", interval_count: 2 },
  quarterly: { interval: "month", interval_count: 3 },
};

interface CartItem {
  productTitle: string;
  productEventId: string;
  amount: number;
  currency: string;
  quantity: number;
  isSubscription: boolean;
  frequency?: string;
  discountPercent?: number;
  subscriptionDiscount?: number;
  sellerPubkey?: string;
  variantInfo?: {
    size?: string;
    volume?: string;
    weight?: string;
    bulk?: string;
  };
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
      "stripe-create-cart-subscription",
      RATE_LIMIT
    ))
  )
    return;

  try {
    const { items, customerEmail, sellerPubkey, buyerPubkey, shippingAddress } =
      req.body as {
        items: CartItem[];
        customerEmail: string;
        sellerPubkey?: string;
        buyerPubkey?: string;
        shippingAddress?: any;
      };

    if (!customerEmail) {
      return res.status(400).json({ error: "Customer email is required" });
    }
    if (!items || items.length === 0) {
      return res.status(400).json({ error: "At least one item is required" });
    }

    const subscriptionItems = items.filter((i) => i.isSubscription);
    if (subscriptionItems.length === 0) {
      return res.status(400).json({
        error:
          "No subscription items found. Use regular payment intent for one-time purchases.",
      });
    }

    for (const item of subscriptionItems) {
      if (!item.frequency || !FREQUENCY_TO_INTERVAL[item.frequency]) {
        return res
          .status(400)
          .json({ error: `Invalid frequency for item: ${item.productTitle}` });
      }
    }

    const firstFiatCurrency = items.find((i) => !isCryptoCurrency(i.currency));
    const effectiveStripeCurrency = firstFiatCurrency
      ? firstFiatCurrency.currency.toLowerCase()
      : "usd";

    const sellerPubkeys = new Set<string>();
    for (const item of items) {
      const pk = item.sellerPubkey || sellerPubkey;
      if (pk) sellerPubkeys.add(pk);
    }

    const isMultiMerchant = sellerPubkeys.size > 1;

    if (isMultiMerchant && !buyerPubkey) {
      // A multi-seller cart creates ONE shared Stripe subscription whose
      // whole-subscription mutations (cancel, address, billing date) are
      // buyer-only — no single seller may act on the other sellers' items.
      // A guest checkout stores no buyer pubkey, so NOBODY could ever
      // manage that subscription. Fail closed at creation instead.
      return res.status(400).json({
        error:
          "Recurring carts with items from multiple sellers require signing in, so you can manage the subscription later.",
        code: "MULTI_SELLER_SUBSCRIPTION_REQUIRES_SIGNIN",
      });
    }

    if (!isMultiMerchant && !sellerPubkey && sellerPubkeys.size === 0) {
      return res.status(400).json({ error: "Vendor pubkey is required" });
    }

    const effectiveSellerPubkey = sellerPubkey || [...sellerPubkeys][0]!;

    if (isMultiMerchant) {
      // AWAIT, not bare return: without it an async throw inside the helper
      // (e.g. the fail-closed split-record write) escapes this try/catch as
      // an unhandled rejection instead of becoming a clean 500.
      return await handleMultiMerchantSubscription(
        items,
        customerEmail,
        buyerPubkey,
        shippingAddress,
        sellerPubkeys,
        effectiveStripeCurrency,
        req.body?.attemptNonce,
        res
      );
    }

    let connectedAccountId: string | null = null;
    const isPlatformAccount =
      effectiveSellerPubkey === process.env.NEXT_PUBLIC_SELF_SOWN_PK;

    if (!isPlatformAccount) {
      const connectAccount = await getStripeConnectAccount(
        effectiveSellerPubkey
      );
      if (connectAccount && connectAccount.charges_enabled) {
        connectedAccountId = connectAccount.stripe_account_id;
      }
    }

    const stripeOptions = connectedAccountId
      ? { stripeAccount: connectedAccountId }
      : undefined;

    // Direct charges run on the connected account, so Apple Pay needs the
    // checkout domain registered THERE (platform host, or this seller's
    // verified custom domain) before the buyer's wallet element initializes.
    // Best-effort: registration failure never blocks checkout.
    const subscriptionRegHost = await trustedRegistrationHost(
      req.headers?.host,
      effectiveSellerPubkey
    );
    if (subscriptionRegHost)
      await registerApplePayDomain(subscriptionRegHost, connectedAccountId);

    const customers = await stripe.customers.list(
      { email: customerEmail, limit: 1 },
      stripeOptions
    );

    let customer: any;
    if (customers.data.length > 0) {
      customer = customers.data[0];
    } else {
      customer = await stripe.customers.create(
        {
          email: customerEmail,
          metadata: {
            buyerPubkey: buyerPubkey || "",
          },
        },
        stripeOptions
      );
    }

    const subscriptionLineItems: Stripe.SubscriptionCreateParams.Item[] = [];
    const oneTimeInvoiceItems: Array<{
      price: string;
      quantity: number;
    }> = [];
    const allFrequencies = subscriptionItems.map((i) => i.frequency!);
    const primaryFrequency = allFrequencies[0]!;

    for (const item of subscriptionItems) {
      const { amountSmallest } = await convertToSmallestUnit(
        item.amount,
        item.currency
      );
      const discount = item.subscriptionDiscount || item.discountPercent || 0;
      const finalAmount = Math.ceil(amountSmallest * (1 - discount / 100));

      if (finalAmount < 50) {
        return res.status(400).json({
          error: `Subscription amount too low for ${item.productTitle}`,
        });
      }

      const product = await stripe.products.create(
        {
          name: item.productTitle || "Subscription Product",
          metadata: {
            productEventId: item.productEventId,
            sellerPubkey: effectiveSellerPubkey,
          },
        },
        stripeOptions
      );

      const intervalConfig = FREQUENCY_TO_INTERVAL[item.frequency!]!;
      const price = await stripe.prices.create(
        {
          product: product.id,
          unit_amount: finalAmount,
          currency: effectiveStripeCurrency,
          recurring: {
            interval: intervalConfig.interval,
            interval_count: intervalConfig.interval_count,
          },
        },
        stripeOptions
      );

      subscriptionLineItems.push({
        price: price.id,
        quantity: 1, // amount is a line total; never re-multiply by qty
      });
    }

    const oneTimeItems = items.filter((i) => !i.isSubscription);
    for (const item of oneTimeItems) {
      const { amountSmallest } = await convertToSmallestUnit(
        item.amount,
        item.currency
      );
      const discount = item.discountPercent || 0;
      const finalAmount = Math.ceil(amountSmallest * (1 - discount / 100));

      if (finalAmount < 50) {
        return res.status(400).json({
          error: `Amount too low for ${item.productTitle}`,
        });
      }

      const product = await stripe.products.create(
        {
          name: item.productTitle || "One-Time Product",
          metadata: {
            productEventId: item.productEventId,
            sellerPubkey: effectiveSellerPubkey,
            isOneTime: "true",
          },
        },
        stripeOptions
      );

      const price = await stripe.prices.create(
        {
          product: product.id,
          unit_amount: finalAmount,
          currency: effectiveStripeCurrency,
        },
        stripeOptions
      );

      // add_invoice_items on the create below keeps the one-time item
      // atomic with the subscription — a failed create leaves nothing
      // pending on the customer for a later cart's first invoice to bill.
      oneTimeInvoiceItems.push({
        price: price.id,
        quantity: 1, // amount is a line total; never re-multiply by qty
      });
    }

    const subscriptionMetadata: Record<string, string> = {
      sellerPubkey: effectiveSellerPubkey,
      buyerPubkey: buyerPubkey || "",
      isCartOrder: "true",
      // No product-coordinate lists here: Nostr coordinates are ~118 chars
      // each and Stripe metadata values cap at 500 chars. The per-item
      // subscriptions rows (product_event_id) are the durable store.
      primaryFrequency,
    };

    // Apply ss_donation parity for direct-charge cart subscriptions.
    const cartDonationPercent =
      connectedAccountId && !isPlatformPubkey(effectiveSellerPubkey)
        ? await getSellerDonationPercent(effectiveSellerPubkey)
        : 0;
    // 100% is a UI-supported setting (full donation) and Stripe allows
    // application_fee_percent up to 100 — honor it verbatim; collapsing it
    // to 0 would pay the seller the full recurring amount.
    const cartApplicationFeePercent =
      cartDonationPercent > 0 && cartDonationPercent <= 100
        ? Math.round(cartDonationPercent * 100) / 100
        : 0;
    if (cartApplicationFeePercent > 0) {
      // Dual-write: ss* canonical; mm* kept for readers against pre-rename
      // Stripe objects.
      subscriptionMetadata.ssDonationPercent =
        cartApplicationFeePercent.toString();
      subscriptionMetadata.mmDonationPercent =
        cartApplicationFeePercent.toString();
    }

    const cartSubIdempotencyKey = stableIdempotencyKey("cartsub", {
      customerId: customer.id,
      subscriptionLineItems,
      oneTimeInvoiceItems,
      metadata: subscriptionMetadata,
    });
    const subscription = await withStripeRetry(() =>
      stripe.subscriptions.create(
        {
          customer: customer.id,
          items: subscriptionLineItems,
          ...(oneTimeInvoiceItems.length > 0 && {
            add_invoice_items: oneTimeInvoiceItems,
          }),
          payment_behavior: "default_incomplete",
          payment_settings: {
            save_default_payment_method: "on_subscription",
          },
          expand: ["latest_invoice.payment_intent"],
          ...(cartApplicationFeePercent > 0 && {
            application_fee_percent: cartApplicationFeePercent,
          }),
          metadata: subscriptionMetadata,
        },
        { ...(stripeOptions ?? {}), idempotencyKey: cartSubIdempotencyKey }
      )
    );

    const subscriptionData = subscription as any;
    // Clover (Basil family) removed Invoice.payment_intent, so the expand
    // above yields nothing — resolve the PI via the invoice's payments.
    const paymentIntent = await resolveSubscriptionPaymentIntent(
      stripe,
      subscription,
      stripeOptions
    );

    const nextBillingDate = subscriptionData.current_period_end
      ? new Date(subscriptionData.current_period_end * 1000)
      : null;

    for (const item of subscriptionItems) {
      const { amountSmallest } = await convertToSmallestUnit(
        item.amount,
        item.currency
      );
      const discount = item.subscriptionDiscount || item.discountPercent || 0;
      const finalAmount = Math.ceil(amountSmallest * (1 - discount / 100));
      const divisor = ZERO_DECIMAL_CURRENCIES.has(effectiveStripeCurrency)
        ? 1
        : 100;

      await createSubscription({
        stripe_subscription_id: subscription.id,
        stripe_customer_id: customer.id,
        buyer_pubkey: buyerPubkey || null,
        buyer_email: customerEmail,
        seller_pubkey: effectiveSellerPubkey,
        product_event_id: item.productEventId,
        product_title: item.productTitle || null,
        connected_account_id: connectedAccountId,
        quantity: item.quantity || 1,
        variant_info: item.variantInfo || null,
        frequency: item.frequency!,
        discount_percent: discount,
        base_price: amountSmallest / divisor,
        subscription_price: finalAmount / divisor,
        currency: effectiveStripeCurrency,
        shipping_address: shippingAddress || null,
        status: "pending",
        next_billing_date: nextBillingDate,
        next_shipping_date: nextBillingDate,
      });
    }

    return res.status(200).json({
      success: true,
      subscriptionId: subscription.id,
      clientSecret: paymentIntent?.client_secret || null,
      customerId: customer.id,
      connectedAccountId: connectedAccountId || undefined,
      status: subscriptionData.status,
      currentPeriodEnd: subscriptionData.current_period_end,
    });
  } catch (error) {
    console.error("Stripe cart subscription creation error:", error);
    const rateError = isExchangeRateError(error);
    return res.status(rateError ? 503 : 500).json({
      error: "Failed to create cart subscription",
      ...(rateError && { code: EXCHANGE_RATE_ERROR_CODE }),
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

async function handleMultiMerchantSubscription(
  items: CartItem[],
  customerEmail: string,
  buyerPubkey: string | undefined,
  shippingAddress: any,
  sellerPubkeys: Set<string>,
  effectiveStripeCurrency: string,
  attemptNonceRaw: unknown,
  res: NextApiResponse
) {
  // Per-attempt nonce (the first-party client generates one per cart state):
  // submit retries of the SAME attempt replay the same transfer group; a
  // new/changed cart is a NEW attempt — fresh record, fresh Stripe objects —
  // so reordering after a cancellation never inherits a dead attempt's
  // consumed one-time invoice items or its (possibly canceled) subscription.
  const attemptNonce =
    typeof attemptNonceRaw === "string" &&
    /^[A-Za-z0-9-]{8,64}$/.test(attemptNonceRaw)
      ? attemptNonceRaw
      : "";
  // Deterministic per buyer+cart+attempt: a retry must replay the SAME
  // attempt — same transfer group, same Stripe params — or the record lookup
  // forks and Stripe rejects the idempotency-key reuse for carrying
  // different parameters.
  const transferGroup = `cart_sub_${stableIdempotencyKey("cartsub-tg", {
    customerEmail,
    buyerPubkey: buyerPubkey || "",
    attemptNonce,
    items: items.map((i) => ({
      productEventId: i.productEventId,
      amount: i.amount,
      currency: i.currency,
      quantity: i.quantity || 1,
      isSubscription: !!i.isSubscription,
      frequency: i.frequency || "",
      discount: i.subscriptionDiscount || i.discountPercent || 0,
      sellerPubkey: i.sellerPubkey || "",
    })),
    sellerPubkeys: [...sellerPubkeys].sort(),
  })}`;

  const sellerAccounts: Record<string, string> = {};
  for (const pubkey of sellerPubkeys) {
    const isPlatformAccount = pubkey === process.env.NEXT_PUBLIC_SELF_SOWN_PK;
    if (!isPlatformAccount) {
      const connectAccount = await getStripeConnectAccount(pubkey);
      if (!connectAccount || !connectAccount.charges_enabled) {
        return res.status(400).json({
          error: `Vendor ${pubkey.substring(
            0,
            8
          )}... does not have Stripe enabled`,
        });
      }
      sellerAccounts[pubkey] = connectAccount.stripe_account_id;
    }
  }

  const subscriptionItems = items.filter((i) => i.isSubscription);
  const oneTimeItems = items.filter((i) => !i.isSubscription);
  const allFrequencies = subscriptionItems.map((i) => i.frequency!);
  const primaryFrequency = allFrequencies[0]!;

  // Phase 1 — pure computation, NO Stripe mutations: per-item final amounts
  // and per-seller totals. Everything fallible but mutation-free happens
  // here so the fail-closed authority-record write below precedes ANY Stripe
  // object creation — a retry after that write must start completely clean.
  interface ComputedCartItem {
    item: CartItem;
    finalAmount: number;
    itemSeller: string;
  }
  const computedSubItems: ComputedCartItem[] = [];
  const computedOneTimeItems: ComputedCartItem[] = [];
  const sellerAmounts: Record<string, number> = {};

  for (const item of subscriptionItems) {
    const { amountSmallest } = await convertToSmallestUnit(
      item.amount,
      item.currency
    );
    const discount = item.subscriptionDiscount || item.discountPercent || 0;
    const finalAmount = Math.ceil(amountSmallest * (1 - discount / 100));

    if (finalAmount < 50) {
      return res.status(400).json({
        error: `Subscription amount too low for ${item.productTitle}`,
      });
    }

    const itemSeller = item.sellerPubkey || [...sellerPubkeys][0]!;
    computedSubItems.push({ item, finalAmount, itemSeller });
    // item.amount is the LINE TOTAL (client sends basePrice × quantity), so
    // no quantity multiplication here — Stripe quantity is forced to 1.
    const totalForItem = finalAmount;
    sellerAmounts[itemSeller] = (sellerAmounts[itemSeller] || 0) + totalForItem;
  }

  for (const item of oneTimeItems) {
    const { amountSmallest } = await convertToSmallestUnit(
      item.amount,
      item.currency
    );
    const discount = item.discountPercent || 0;
    const finalAmount = Math.ceil(amountSmallest * (1 - discount / 100));

    if (finalAmount < 50) {
      return res.status(400).json({
        error: `Amount too low for ${item.productTitle}`,
      });
    }

    const itemSeller = item.sellerPubkey || [...sellerPubkeys][0]!;
    computedOneTimeItems.push({ item, finalAmount, itemSeller });
    // item.amount is the LINE TOTAL (client sends basePrice × quantity), so
    // no quantity multiplication here — Stripe quantity is forced to 1.
    const totalForItem = finalAmount;
    sellerAmounts[itemSeller] = (sellerAmounts[itemSeller] || 0) + totalForItem;
  }

  const sellerSplits: {
    pubkey: string;
    amountCents: number;
    accountId: string;
    donationPercent: number;
    donationCutSmallest: number;
  }[] = [];
  for (const [pubkey, amountCents] of Object.entries(sellerAmounts)) {
    const isPlatformAccount = pubkey === process.env.NEXT_PUBLIC_SELF_SOWN_PK;
    const donationPercent = isPlatformAccount
      ? 0
      : await getSellerDonationPercent(pubkey);
    const donationCutSmallest = isPlatformAccount
      ? 0
      : computeDonationCutSmallest(amountCents, donationPercent);
    sellerSplits.push({
      pubkey,
      amountCents,
      accountId: isPlatformAccount ? "" : sellerAccounts[pubkey] || "",
      donationPercent,
      donationCutSmallest,
    });
  }

  // Phase 2 — the authority record BEFORE any Stripe mutation. Stripe caps
  // every metadata value at 500 chars — the full split details JSON
  // (donation fields per seller) blows past that with just TWO sellers,
  // which used to fail every multi-seller recurring cart here with a 400.
  // Mirror the card-checkout fix: persist the full split details server-side
  // in stripe_pending_payments (JSONB, no size cap) keyed by the transfer
  // group, keep the subscription metadata compact, and stamp the authority
  // marker so the webhook fails closed if this record is ever missing.
  // Fail closed: the webhook pays sellers out of this record, so a recurring
  // cart whose record can't be durably saved must NOT become payable — and
  // because nothing exists at Stripe yet, the buyer's retry is clean.
  const totalAmountSmallest = sellerSplits.reduce(
    (sum, s) => sum + s.amountCents,
    0
  );
  // The created flag is the atomic attempt claim: concurrent identical
  // requests get exactly ONE owner. A loser must never create Stripe objects
  // (see the replay/concurrency gate below).
  const { created: claimed, claimToken } = await recordPendingPayment({
    intentRef: transferGroup,
    amount: totalAmountSmallest,
    currency: effectiveStripeCurrency,
    metadata: {
      transferGroup,
      sellerSplits,
      kind: "cart-subscription",
      // JSONB has no 500-char cap — the product-coordinate lists that would
      // blow Stripe metadata live here.
      productEventIds: items.map((i) => i.productEventId),
      // Lifecycle tracking for the prune sweep: from here on, this record's
      // metadata durably records how far the attempt got, so cleanup can
      // tell "no subscription can exist" apart from "unknowable".
      [SUBSCRIPTION_ATTEMPT_TRACKED_METADATA_KEY]: true,
    },
  });
  // The token fences every later conditional write: a reclaim rotates it,
  // so if this attempt goes stale and is taken over, its resumed writes
  // match zero rows (PendingPaymentClaimLostError) instead of clobbering
  // the new owner's record.
  let attemptToken: string | null = claimToken;

  // Phase 3 — Stripe mutations. One-time items ride the subscription create
  // itself via add_invoice_items — ATOMIC with it: a failed create leaves
  // nothing pending on the customer, so a later cart's first invoice can
  // never pick up (and double-charge) a stale attempt's one-time items.
  const subscriptionLineItems: Stripe.SubscriptionCreateParams.Item[] = [];
  // Per-price seller attribution for BOTH recurring and one-time items,
  // persisted into the authority record below so the invoice.paid webhook
  // can derive each invoice's payouts from its ACTUAL lines — a renewal must
  // only pay the sellers whose items are on it (never one-time items or
  // other cadences), which a static split total cannot express. quantity +
  // recurring are included so a retry can rebuild the exact subscription
  // params from the record without creating any new Stripe objects.
  let priceAllocations: {
    priceId: string;
    sellerPubkey: string;
    quantity: number;
    recurring: boolean;
  }[] = [];
  const oneTimeInvoiceItems: { price: string; quantity: number }[] = [];
  let subscriptionCreated = false;
  let subscription: Stripe.Subscription;
  let customer: any;

  // Replay/concurrency gate: only the claim owner may create Stripe objects.
  // A non-owner replays from the record's stamped allocations (byte-identical
  // params under the same idempotency key → Stripe replays the original
  // subscription); if the owner hasn't stamped yet it is told to retry; a
  // stale owner (>2min without stamping) is presumed dead and taken over.
  // Competing creation must be impossible: Stripe accepts only ONE param set
  // per idempotency key and the record holds one allocation set, so two
  // creators could leave the record pointing at the rejected price ids.
  let replayAllocations: typeof priceAllocations | null = null;
  if (!claimed) {
    const priorRecord = await getPendingPayment(transferGroup);
    const priorAllocations = priorRecord?.metadata?.priceAllocations;
    const isReplayableAllocation = (a: any) =>
      a &&
      typeof a.priceId === "string" &&
      a.priceId &&
      typeof a.sellerPubkey === "string" &&
      a.sellerPubkey &&
      typeof a.quantity === "number" &&
      a.quantity > 0 &&
      typeof a.recurring === "boolean";
    if (
      Array.isArray(priorAllocations) &&
      priorAllocations.length > 0 &&
      priorAllocations.every(isReplayableAllocation)
    ) {
      replayAllocations = priorAllocations as typeof priceAllocations;
      // Fence the bookkeeping writes below: a replay may only mutate the
      // record while it OWNS the claim. If the original owner is dead
      // (stale/failed_terminal) this fenced reclaim hands us a fresh token;
      // if it is still live the reclaim returns null and every
      // updatePendingPayment below is SKIPPED — a tokenless write is
      // unconditional and could clobber the live owner's authority record
      // (e.g. replacing its donation/account split data with retry-time
      // recomputations).
      attemptToken = await reclaimPendingPayment(transferGroup, 120_000);
    } else {
      // Nothing stamped to replay — take over the attempt via a FENCED
      // reclaim (one UPDATE ... WHERE status/age ... RETURNING): of any
      // number of concurrent retries seeing the same reclaimable record,
      // exactly one wins and every loser backs off. Without the fence,
      // competing retries would create different Price ids under one
      // subscription idempotency key — Stripe accepts only the first param
      // set, and the record could end up pointing at the rejected prices.
      const reclaimToken = await reclaimPendingPayment(transferGroup, 120_000);
      if (!reclaimToken) {
        return res.status(409).json({
          error:
            "A checkout for this cart is already in progress. Please retry in a few seconds.",
          code: "CHECKOUT_IN_PROGRESS",
        });
      }
      // Reclaimed ownership (and its fresh fencing token) — full creation.
      attemptToken = reclaimToken;
    }
  }

  try {
    // Customer resolution is the FIRST Stripe mutation and happens only
    // after the authority record is durably persisted — a retry finds the
    // same customer by email, but a failed record write must leave no
    // Stripe footprint at all.
    const customers = await stripe.customers.list({
      email: customerEmail,
      limit: 1,
    });

    if (customers.data.length > 0) {
      customer = customers.data[0];
    } else {
      customer = await stripe.customers.create({
        email: customerEmail,
        metadata: {
          buyerPubkey: buyerPubkey || "",
        },
      });
    }

    if (replayAllocations) {
      priceAllocations = replayAllocations;
      for (const a of replayAllocations) {
        if (a.recurring) {
          subscriptionLineItems.push({
            price: a.priceId,
            quantity: a.quantity,
          });
        } else {
          // Replayed byte-identically into add_invoice_items below.
          oneTimeInvoiceItems.push({ price: a.priceId, quantity: a.quantity });
        }
      }
    } else {
      for (const { item, finalAmount, itemSeller } of computedSubItems) {
        const product = await stripe.products.create({
          name: item.productTitle || "Subscription Product",
          metadata: {
            productEventId: item.productEventId,
            sellerPubkey: itemSeller,
          },
        });

        const intervalConfig = FREQUENCY_TO_INTERVAL[item.frequency!]!;
        const price = await stripe.prices.create({
          product: product.id,
          unit_amount: finalAmount,
          currency: effectiveStripeCurrency,
          recurring: {
            interval: intervalConfig.interval,
            interval_count: intervalConfig.interval_count,
          },
        });

        subscriptionLineItems.push({
          price: price.id,
          quantity: 1, // amount is a line total; never re-multiply by qty
        });
        priceAllocations.push({
          priceId: price.id,
          sellerPubkey: itemSeller,
          quantity: 1, // amount is a line total; never re-multiply by qty
          recurring: true,
        });
      }

      for (const { item, finalAmount, itemSeller } of computedOneTimeItems) {
        const product = await stripe.products.create({
          name: item.productTitle || "One-Time Product",
          metadata: {
            productEventId: item.productEventId,
            sellerPubkey: itemSeller,
            isOneTime: "true",
          },
        });

        const price = await stripe.prices.create({
          product: product.id,
          unit_amount: finalAmount,
          currency: effectiveStripeCurrency,
        });

        oneTimeInvoiceItems.push({
          price: price.id,
          quantity: 1, // amount is a line total; never re-multiply by qty
        });
        priceAllocations.push({
          priceId: price.id,
          sellerPubkey: itemSeller,
          quantity: 1, // amount is a line total; never re-multiply by qty
          recurring: false,
        });
      }

      // Stamp the price→seller allocations into the authority record. Fail
      // closed here too: without them every renewal would fall back to the
      // static split totals and re-pay one-time items and other cadences.
      await updatePendingPayment(transferGroup, {
        claimToken: attemptToken,
        metadata: {
          transferGroup,
          sellerSplits,
          priceAllocations,
          kind: "cart-subscription",
          // metadata writes REPLACE wholesale — restate the lifecycle marker
          // stamped at record creation or it is silently dropped here.
          [SUBSCRIPTION_ATTEMPT_TRACKED_METADATA_KEY]: true,
        },
      });
    }

    // 64-hex pubkeys at ~65 chars each hit the 500-char cap around 7
    // sellers; omit the list for pathological carts rather than failing the
    // checkout (the authority record above is what the webhook pays from).
    const sellerPubkeysJoined = [...sellerPubkeys].join(",");

    const subscriptionMetadata: Record<string, string> = {
      isMultiMerchant: "true",
      transferGroup,
      buyerPubkey: buyerPubkey || "",
      isCartOrder: "true",
      // Product coordinates stay OUT of Stripe metadata: Nostr coordinates
      // are ~118 chars each, so a moderate cart blows the 500-char metadata
      // cap. They live in the JSONB authority record (productEventIds) and
      // the per-item subscriptions rows instead.
      primaryFrequency,
      // Server-owned authority marker: a marked subscription whose split
      // record is missing must fail closed in the webhook, never fall
      // through to the legacy metadata path and silently skip payouts.
      [SPLIT_AUTHORITY_METADATA_KEY]: SPLIT_AUTHORITY_PENDING_RECORD,
      ...(sellerPubkeysJoined.length <= 490 && {
        sellerPubkeys: sellerPubkeysJoined,
      }),
    };

    // Durable pre-create marker, stamped BEFORE the create call: after this
    // lands, a crash/timeout leaves an AMBIGUOUS record (attempted, never
    // conclusively failed) that the prune sweep must preserve, because
    // Stripe may hold a live subscription under the idempotency key. Fail
    // closed like the allocation stamp above: without this marker the same
    // crash window would leave a row that looks safe to delete. Token-gated
    // for the same reason as every other bookkeeping write; the marker also
    // clears any stale FAILED flag from a previous reclaimed attempt.
    if (attemptToken) {
      await updatePendingPayment(transferGroup, {
        claimToken: attemptToken,
        metadata: {
          transferGroup,
          sellerSplits,
          priceAllocations,
          kind: "cart-subscription",
          productEventIds: items.map((i) => i.productEventId),
          [SUBSCRIPTION_ATTEMPT_TRACKED_METADATA_KEY]: true,
          [SUBSCRIPTION_CREATE_ATTEMPTED_METADATA_KEY]: Date.now(),
        },
      });
    }

    // The transfer group IS the idempotency key: it is deterministic per
    // buyer+cart and the params are replay-identical (price ids come from
    // the record on retries), so a retry after a post-create failure —
    // e.g. the per-item DB rows — replays the SAME Stripe subscription
    // instead of creating a duplicate live one or erroring on key reuse.
    subscription = await withStripeRetry(() =>
      stripe.subscriptions.create(
        {
          customer: customer.id,
          items: subscriptionLineItems,
          // One-time items are atomic with the subscription: they bill ONLY
          // on its first invoice and exist only if the create succeeds.
          ...(oneTimeInvoiceItems.length > 0 && {
            add_invoice_items: oneTimeInvoiceItems,
          }),
          payment_behavior: "default_incomplete",
          payment_settings: {
            save_default_payment_method: "on_subscription",
          },
          expand: ["latest_invoice.payment_intent"],
          metadata: subscriptionMetadata,
          transfer_data: undefined,
        },
        { idempotencyKey: transferGroup }
      )
    );
    subscriptionCreated = true;
  } catch (err) {
    // Token-gated: a tokenless replay (live owner) must never mark the
    // record failed over the owner's head.
    if (!subscriptionCreated && attemptToken) {
      // A 4xx from Stripe is a CONCLUSIVE refusal: the request was processed
      // and rejected, an idempotent replay returns the same refusal, and no
      // subscription exists under the transfer-group key — the prune sweep
      // may delete this record once it ages out. Anything else (timeout,
      // connection drop, 5xx) is AMBIGUOUS when raised by the create call:
      // Stripe may hold a live subscription, so the record must survive for
      // the invoice.paid webhook to keep paying out of it.
      const statusCode = (err as { statusCode?: unknown })?.statusCode;
      const conclusiveRejection =
        typeof statusCode === "number" && statusCode >= 400 && statusCode < 500;
      // Merge into the record's CURRENT metadata rather than restating from
      // locals: a 4xx mid product/price creation would otherwise persist
      // partial priceAllocations and poison a later replay. If the read
      // fails, skip the marker (conservative: the row is preserved).
      let metadata: Record<string, unknown> | undefined;
      if (conclusiveRejection) {
        const current = await getPendingPayment(transferGroup).catch(
          () => null
        );
        if (current) {
          metadata = {
            ...current.metadata,
            [SUBSCRIPTION_CREATE_FAILED_METADATA_KEY]: Date.now(),
          };
        }
      }
      // Release the attempt claim so the buyer's retry takes over
      // immediately (released records are reclaimable at the gate above)
      // instead of 409ing until the record goes stale. Best-effort: the
      // staleness window is the backstop for a hard crash.
      await updatePendingPayment(transferGroup, {
        status: "failed_terminal",
        claimToken: attemptToken,
        lastErrorMessage: err instanceof Error ? err.message : String(err),
        ...(metadata && { metadata }),
      }).catch(() => {});
    }
    // No invoice-item cleanup is needed here: one-time items ride the
    // subscription create (add_invoice_items), so a failed create never
    // leaves pending items on the customer for a later cart to pick up.
    throw err;
  }

  const subscriptionData = subscription as any;
  // Clover (Basil family) removed Invoice.payment_intent, so the expand
  // above yields nothing — resolve the PI via the invoice's payments.
  const paymentIntent = await resolveSubscriptionPaymentIntent(
    stripe,
    subscription
  );

  // The subscription exists and the split record above is what the
  // invoice.paid webhook pays out of — mark it live. Best-effort only: the
  // webhook resolves splits from the record's metadata regardless of status,
  // and a throw here would 500 AFTER the subscription was created, tempting
  // the buyer into a duplicate-subscription retry.
  // Token-gated: a tokenless replay (live owner) replays the Stripe objects
  // but leaves ALL record bookkeeping to the owner.
  if (attemptToken) {
    await updatePendingPayment(transferGroup, {
      status: "created",
      claimToken: attemptToken,
      // Persist the Stripe identity for reconciliation (support lookups,
      // duplicate-attempt detection). metadata REPLACES, so restate it whole.
      metadata: {
        transferGroup,
        sellerSplits,
        priceAllocations,
        kind: "cart-subscription",
        productEventIds: items.map((i) => i.productEventId),
        stripeSubscriptionId: subscription.id,
        stripeCustomerId: customer.id,
      },
    }).catch((err) =>
      console.error(
        `Failed to mark pending subscription split record ${transferGroup} as created:`,
        err
      )
    );
  }

  const nextBillingDate = subscriptionData.current_period_end
    ? new Date(subscriptionData.current_period_end * 1000)
    : null;

  for (const item of subscriptionItems) {
    const { amountSmallest } = await convertToSmallestUnit(
      item.amount,
      item.currency
    );
    const discount = item.subscriptionDiscount || item.discountPercent || 0;
    const finalAmount = Math.ceil(amountSmallest * (1 - discount / 100));
    const itemSeller = item.sellerPubkey || [...sellerPubkeys][0]!;
    const divisor = ZERO_DECIMAL_CURRENCIES.has(effectiveStripeCurrency)
      ? 1
      : 100;

    await createSubscription({
      stripe_subscription_id: subscription.id,
      stripe_customer_id: customer.id,
      buyer_pubkey: buyerPubkey || null,
      buyer_email: customerEmail,
      seller_pubkey: itemSeller,
      product_event_id: item.productEventId,
      product_title: item.productTitle || null,
      connected_account_id: null,
      quantity: item.quantity || 1,
      variant_info: item.variantInfo || null,
      frequency: item.frequency!,
      discount_percent: discount,
      base_price: amountSmallest / divisor,
      subscription_price: finalAmount / divisor,
      currency: effectiveStripeCurrency,
      shipping_address: shippingAddress || null,
      status: "pending",
      next_billing_date: nextBillingDate,
      next_shipping_date: nextBillingDate,
    });
  }

  return res.status(200).json({
    success: true,
    subscriptionId: subscription.id,
    clientSecret: paymentIntent?.client_secret || null,
    customerId: customer.id,
    connectedAccountId: undefined,
    isMultiMerchant: true,
    transferGroup,
    sellerSplits,
    status: subscriptionData.status,
    currentPeriodEnd: subscriptionData.current_period_end,
  });
}
