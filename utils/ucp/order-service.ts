import { randomBytes } from "crypto";
import Stripe from "stripe";
import { Mint as CashuMint, Wallet as CashuWallet } from "@cashu/cashu-ts";
import {
  fetchAllProductsFromDb,
  fetchAllProfilesFromDb,
  getStripeConnectAccount,
  validateDiscountCode,
  markDiscountCodeUsed,
} from "@/utils/db/db-service";
import {
  createMcpOrder,
  updateMcpOrderPayment,
  type McpOrder,
} from "@/mcp/tools/purchase-tools";
import { parseTags } from "@/utils/parsers/product-parser-functions";
import { checkAvailability, deductStock } from "@/utils/db/inventory-service";
import { isBitcoinCurrency, SATS_PER_BTC } from "@/utils/ucp/money";

/**
 * Shared, protocol-neutral order engine.
 *
 * This module owns product validation, quote math, and the payment side effects
 * that used to live inline in `pages/api/mcp/create-order.ts`. Both the MCP
 * create-order route and the UCP checkout-session route call it, so the two
 * surfaces can never drift in pricing, inventory, discount, or payment behavior.
 *
 * The engine returns NEUTRAL result objects (or throws `OrderServiceError`) and
 * performs NO HTTP work: it never touches `res`, never sets headers, and never
 * decides status codes for the wire. Each caller formats the result into its own
 * representation (the MCP route reproduces its exact legacy bodies + L402
 * header; the UCP route maps it onto a checkout session). Keeping all I/O in the
 * callers is what lets the MCP contract stay byte-for-byte identical.
 */

export type PaymentMethod = "stripe" | "lightning" | "cashu" | "fiat";

export const DEFAULT_MINT_URL = "https://mint.minibits.cash/Bitcoin";

// Server-controlled allowlist of Cashu mints the backend will trust for both
// Lightning invoice creation and Cashu token redemption. Buyer-supplied mint
// URLs that are not in this set are rejected before any network call is made.
export const ALLOWED_MINT_URLS: ReadonlySet<string> = new Set([
  DEFAULT_MINT_URL,
]);

/**
 * In-memory pending Lightning quotes, keyed by order id. `verify-payment`
 * imports this exact singleton (re-exported from create-order for back-compat),
 * so it MUST stay a single shared instance — do not clone it per caller.
 */
export const pendingLightningPayments = new Map<
  string,
  {
    quote: string;
    mintUrl: string;
    amount: number;
    orderId: string;
    productId: string;
    quantity: number;
    inventoryVariantKey: string;
    // Captured at order-create time so we can mark the discount code used
    // ONLY when the Lightning invoice is actually settled (see verify-payment).
    // If the buyer abandons before paying, the code stays available.
    discountCode?: string;
    sellerPubkey?: string;
  }
>();

/**
 * A validation / business-rule failure carrying the exact HTTP status + JSON
 * body the MCP route already returns today. Callers translate it to the wire.
 */
export class OrderServiceError extends Error {
  status: number;
  body: Record<string, any>;
  constructor(status: number, body: Record<string, any>) {
    super(typeof body?.error === "string" ? body.error : "Order error");
    this.name = "OrderServiceError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Resolve a price into the integer satoshi amount used to settle a sats-native
 * payment (Lightning/Cashu).
 *
 * Bitcoin-denominated prices are a fixed unit conversion: sats are already sats;
 * a whole-BTC price is × 1e8. A FIAT price, by contrast, needs a live exchange
 * rate — and charge math must NEVER reuse the buyer-facing display FX (which can
 * be stale or null). With no authoritative rate in the charge path we FAIL
 * CLOSED: rather than silently treat e.g. $12 as 12 sats (mischarging the
 * buyer), we throw an escalation error so UCP checkout reports
 * `requires_escalation` and no order is placed.
 */
function resolveSatsAmount(currency: string, totalAmount: number): number {
  const lower = (currency || "").trim().toLowerCase();
  if (isBitcoinCurrency(lower)) {
    const sats =
      lower === "btc"
        ? Math.round(totalAmount * SATS_PER_BTC)
        : Math.ceil(totalAmount);
    return sats < 1 ? 1 : sats;
  }
  throw new OrderServiceError(422, {
    error: `This product is priced in ${currency.toUpperCase()} and can't be settled in Bitcoin without a live exchange rate, which isn't available in the charge path. Pay with a card (Stripe) or a manual fiat method, or ask the seller to price the item in sats.`,
    code: "exchange_rate_unavailable",
    escalate: true,
    currency: currency.toUpperCase(),
    paymentSettlement: "sats",
  });
}

export function generateMcpOrderId(): string {
  return `mcp_${Date.now()}_${randomBytes(4).toString("hex")}`;
}

export async function getSellerProfile(sellerPubkey: string) {
  const profiles = await fetchAllProfilesFromDb();
  const profile = profiles.find(
    (p) => p.pubkey === sellerPubkey && (p.kind === 0 || p.kind === 30019)
  );
  if (!profile) return null;
  try {
    return JSON.parse(profile.content);
  } catch {
    return null;
  }
}

export interface CreateOrderFlowInput {
  productId: string;
  quantity?: number;
  buyerEmail?: string | null;
  shippingAddress?: Record<string, string> | null;
  selectedSize?: string;
  selectedVolume?: string;
  selectedWeight?: string;
  selectedBulkUnits?: number;
  discountCode?: string;
  paymentMethod?: PaymentMethod;
  mintUrl?: string;
  cashuToken?: string;
  fiatMethod?: string;
  subscriptionFrequency?: string;
  apiKeyId: number;
  buyerPubkey: string;
}

/** Resolved product + per-line selection, shared by quotes and subscriptions. */
interface ProductSelection {
  product: any;
  productId: string;
  quantity: number;
  unitPrice: number;
  currency: string;
  selectedSpecs: Record<string, any>;
}

/** Full priced quote for a non-subscription order. */
export interface OrderQuote extends ProductSelection {
  effectiveQuantity: number;
  subtotal: number;
  shippingCost: number;
  totalAmount: number;
  discountPercentage: number;
  validatedDiscountCode: string | null;
  inventoryVariantKey: string;
  emailOptions: Record<string, any>;
  sellerProfile: any;
  pricingBlock: Record<string, any>;
}

export type OrderFlowResult =
  | {
      kind: "lightning";
      order: McpOrder;
      bolt11: string;
      quoteId: string;
      amountSats: number;
      mintUrl: string;
      pricingBlock: Record<string, any>;
    }
  | {
      kind: "cashu";
      order: McpOrder;
      tokenAmount: number;
      requiredAmount: number;
      change: number;
      pricingBlock: Record<string, any>;
    }
  | {
      kind: "fiat";
      order: McpOrder;
      fiatOptions: string[];
      selectedMethod: string | null;
      sellerContact: { name: string | null; nip05: string | null };
      amount: number;
      currency: string;
      pricingBlock: Record<string, any>;
    }
  | {
      kind: "stripe";
      order: McpOrder;
      paymentIntentId: string | null;
      clientSecret: string | null;
      connectedAccountId: string | null;
      amount: number;
      currency: string;
      pricingBlock: Record<string, any>;
    }
  | {
      kind: "subscription";
      subscriptionId: string;
      frequency: string;
      status: string;
      // Carry the raw upstream values (possibly undefined) so the MCP route can
      // omit absent fields exactly as the legacy inline handler did.
      currentPeriodEnd: number | undefined;
      recurringAmount: number;
      currency: string;
      quantity: number;
      discountPercent: number;
      clientSecret: string | undefined;
      customerId: string | undefined;
      connectedAccountId: string | undefined;
    };

const VALID_METHODS: PaymentMethod[] = ["stripe", "lightning", "cashu", "fiat"];

/**
 * Top-level entry: validate, price, and initialize payment for one order.
 * Returns a neutral result the caller formats, or throws `OrderServiceError`.
 *
 * The sequencing mirrors the original MCP handler exactly: resolve the product +
 * per-line selection (incl. size/stock checks) FIRST, branch to the Stripe
 * subscription path BEFORE any bulk/discount math, otherwise compute the full
 * quote and dispatch to the per-method payment initializer.
 */
export async function createOrderFlow(
  input: CreateOrderFlowInput
): Promise<OrderFlowResult> {
  const paymentMethod: PaymentMethod = input.paymentMethod || "stripe";

  if (!input.productId) {
    throw new OrderServiceError(400, { error: "productId is required" });
  }
  const quantity = input.quantity ?? 1;
  if (quantity < 1 || !Number.isInteger(quantity)) {
    throw new OrderServiceError(400, {
      error: "quantity must be a positive integer",
    });
  }
  if (!VALID_METHODS.includes(paymentMethod)) {
    throw new OrderServiceError(400, {
      error: `Invalid paymentMethod. Must be one of: ${VALID_METHODS.join(
        ", "
      )}`,
    });
  }

  const selection = await resolveSelection(input, quantity);

  if (input.subscriptionFrequency) {
    return initializeSubscription(input, selection, paymentMethod);
  }

  const quote = await computeQuoteTotals(input, selection, paymentMethod);
  const orderId = generateMcpOrderId();
  return initializeOrderPayment(input, quote, orderId, paymentMethod);
}

/**
 * Resolve the product + per-line selection: product lookup/parse, size + stock
 * validation, and volume/weight unit-price resolution. No order/payment side
 * effects. Shared by both the priced-quote path and the subscription path.
 */
async function resolveSelection(
  input: CreateOrderFlowInput,
  quantity: number
): Promise<ProductSelection> {
  const { productId } = input;
  const allProducts = await fetchAllProductsFromDb();
  const productEvent = allProducts.find((p) => p.id === productId);
  if (!productEvent) {
    throw new OrderServiceError(404, { error: "Product not found" });
  }

  const product = parseTags(productEvent);
  if (!product) {
    throw new OrderServiceError(500, {
      error: "Failed to parse product data",
    });
  }

  const selectedSpecs: Record<string, any> = {};
  const { selectedSize, selectedVolume, selectedWeight } = input;

  if (selectedSize) {
    if (!product.sizes || !product.sizes.includes(selectedSize)) {
      throw new OrderServiceError(400, {
        error: `Invalid size selection: "${selectedSize}"`,
        availableSizes: product.sizes || [],
      });
    }
    const inventoryCheck = await checkAvailability(
      productId,
      quantity,
      selectedSize
    );
    if (inventoryCheck.tracked) {
      if (!inventoryCheck.available) {
        throw new OrderServiceError(400, {
          error: `Insufficient stock for size "${selectedSize}"`,
          available: inventoryCheck.stock,
          requested: quantity,
        });
      }
    } else {
      const sizeStock = product.sizeQuantities?.get(selectedSize);
      if (sizeStock !== undefined && sizeStock < quantity) {
        throw new OrderServiceError(400, {
          error: `Insufficient stock for size "${selectedSize}"`,
          available: sizeStock,
          requested: quantity,
        });
      }
    }
    selectedSpecs.size = selectedSize;
  } else {
    const inventoryCheck = await checkAvailability(productId, quantity);
    if (inventoryCheck.tracked) {
      if (!inventoryCheck.available) {
        throw new OrderServiceError(400, {
          error: "Insufficient stock",
          available: inventoryCheck.stock,
          requested: quantity,
        });
      }
    } else if (product.quantity !== undefined && product.quantity < quantity) {
      throw new OrderServiceError(400, {
        error: "Insufficient stock",
        available: product.quantity,
        requested: quantity,
      });
    }
  }

  let unitPrice = product.price;
  const currency = product.currency || "sats";

  if (selectedVolume) {
    if (!product.volumes || !product.volumes.includes(selectedVolume)) {
      throw new OrderServiceError(400, {
        error: `Invalid volume selection: "${selectedVolume}"`,
        availableVolumes: product.volumes || [],
      });
    }
    const volumePrice = product.volumePrices?.get(selectedVolume);
    if (volumePrice !== undefined) {
      unitPrice = volumePrice;
    }
    selectedSpecs.volume = selectedVolume;
    selectedSpecs.volumePrice = unitPrice;
  }

  if (selectedWeight) {
    if (!product.weights || !product.weights.includes(selectedWeight)) {
      throw new OrderServiceError(400, {
        error: `Invalid weight selection: "${selectedWeight}"`,
        availableWeights: product.weights || [],
      });
    }
    const weightPrice = product.weightPrices?.get(selectedWeight);
    if (weightPrice !== undefined) {
      unitPrice = weightPrice;
    }
    selectedSpecs.weight = selectedWeight;
    selectedSpecs.weightPrice = unitPrice;
  }

  return { product, productId, quantity, unitPrice, currency, selectedSpecs };
}

/**
 * Compute the priced quote (bulk, shipping, discount code, seller payment-method
 * discount, total, pricing block) for a non-subscription order. Read-only DB
 * access (discount validation + seller profile); no order is created.
 */
export async function computeQuoteTotals(
  input: CreateOrderFlowInput,
  selection: ProductSelection,
  paymentMethod: PaymentMethod
): Promise<OrderQuote> {
  const { product, productId, quantity, currency } = selection;
  const { selectedVolume, selectedWeight, selectedBulkUnits, discountCode } =
    input;
  const selectedSpecs = { ...selection.selectedSpecs };
  const unitPrice = selection.unitPrice;

  let effectiveQuantity = quantity;
  let subtotal: number;

  if (selectedBulkUnits) {
    const selectedVariant = selectedVolume || selectedWeight || null;
    let resolvedBulkPrices: Map<number, number> | undefined;
    if (selectedVariant && product.variantBulkPrices) {
      resolvedBulkPrices = product.variantBulkPrices.get(selectedVariant);
    }
    if (!resolvedBulkPrices && product.bulkPrices) {
      resolvedBulkPrices = product.bulkPrices;
    }
    if (!resolvedBulkPrices || !resolvedBulkPrices.has(selectedBulkUnits)) {
      throw new OrderServiceError(400, {
        error: `Invalid bulk tier: ${selectedBulkUnits} units`,
        availableBulkTiers: resolvedBulkPrices
          ? Array.from(resolvedBulkPrices.entries()).map(([units, price]) => ({
              units,
              totalPrice: price,
            }))
          : [],
      });
    }
    const bulkTotalPrice = resolvedBulkPrices.get(selectedBulkUnits)!;
    subtotal = bulkTotalPrice * quantity;
    effectiveQuantity = selectedBulkUnits * quantity;
    selectedSpecs.bulk = {
      units: selectedBulkUnits,
      totalPrice: bulkTotalPrice,
      bundles: quantity,
    };
  } else {
    subtotal = unitPrice * quantity;
  }

  let shippingCost = product.shippingCost || 0;
  if (
    product.shippingType === "Free" ||
    product.shippingType === "Free/Pickup" ||
    product.shippingType === "Pickup" ||
    product.shippingType === "N/A"
  ) {
    shippingCost = 0;
  }

  let discountPercentage = 0;
  let validatedDiscountCode: string | null = null;

  if (discountCode) {
    const discountResult = await validateDiscountCode(
      discountCode,
      product.pubkey
    );
    if (discountResult.valid && discountResult.discount_percentage) {
      discountPercentage = discountResult.discount_percentage;
      subtotal = subtotal * (1 - discountPercentage / 100);
      // NOTE: We do NOT call markDiscountCodeUsed here. A discount code is
      // only consumed when the payment actually succeeds — otherwise a buyer
      // who validates a code but abandons checkout would burn a use against
      // a code's max_uses limit. The code is plumbed through to each
      // payment path and marked used at the moment the order transitions
      // to "paid" (verify-payment for Lightning, post-redeem for Cashu).
      // Stripe/fiat MCP paths have no automatic confirmation today, so the
      // code stays unconsumed until those flows gain a confirmation hook.
      validatedDiscountCode = discountCode;
    }
  }

  const sellerProfile = await getSellerProfile(product.pubkey);
  if (
    sellerProfile?.paymentMethodDiscounts &&
    typeof sellerProfile.paymentMethodDiscounts === "object"
  ) {
    const discountKey =
      paymentMethod === "lightning" || paymentMethod === "cashu"
        ? "bitcoin"
        : paymentMethod === "fiat" && input.fiatMethod
          ? input.fiatMethod.toLowerCase()
          : paymentMethod;
    const methodDiscount = sellerProfile.paymentMethodDiscounts[discountKey];
    if (typeof methodDiscount === "number" && methodDiscount > 0) {
      subtotal = subtotal * (1 - methodDiscount / 100);
    }
  }

  const totalAmount = subtotal + shippingCost;

  const pricingBlock: Record<string, any> = {
    unitPrice,
    quantity: effectiveQuantity,
    subtotal: selectedBulkUnits
      ? (() => {
          const sv = selectedVolume || selectedWeight || null;
          let bp =
            sv && product.variantBulkPrices
              ? product.variantBulkPrices.get(sv)
              : undefined;
          if (!bp) bp = product.bulkPrices;
          return (bp?.get(selectedBulkUnits) ?? unitPrice) * quantity;
        })()
      : unitPrice * quantity,
    discountPercentage: discountPercentage || undefined,
    discountedSubtotal: discountPercentage ? subtotal : undefined,
    shippingCost,
    total: totalAmount,
    currency,
  };

  if (Object.keys(selectedSpecs).length > 0) {
    pricingBlock.selectedSpecs = selectedSpecs;
  }

  const inventoryVariantKey = input.selectedSize
    ? `size:${input.selectedSize}`
    : "_default";

  const emailOptions = {
    shippingAddress: input.shippingAddress
      ? Object.values(input.shippingAddress).filter(Boolean).join(", ")
      : null,
    selectedSize: input.selectedSize,
    selectedVolume: input.selectedVolume,
    selectedWeight: input.selectedWeight,
    selectedBulkUnits: input.selectedBulkUnits,
    quantity: effectiveQuantity,
  };

  return {
    product,
    productId,
    quantity,
    unitPrice,
    currency,
    selectedSpecs,
    effectiveQuantity,
    subtotal,
    shippingCost,
    totalAmount,
    discountPercentage,
    validatedDiscountCode,
    inventoryVariantKey,
    emailOptions,
    sellerProfile,
    pricingBlock,
  };
}

/**
 * Public quote helper: validate + price a non-subscription order without
 * creating it or initializing payment. Useful for "preview" callers (e.g. a UCP
 * checkout session that wants to show a quote before charging).
 */
export async function prepareOrderQuote(
  input: CreateOrderFlowInput
): Promise<OrderQuote> {
  const paymentMethod: PaymentMethod = input.paymentMethod || "stripe";
  const quantity = input.quantity ?? 1;
  const selection = await resolveSelection(input, quantity);
  return computeQuoteTotals(input, selection, paymentMethod);
}

/** Dispatch the priced quote to the per-method payment initializer. */
async function initializeOrderPayment(
  input: CreateOrderFlowInput,
  quote: OrderQuote,
  orderId: string,
  paymentMethod: PaymentMethod
): Promise<OrderFlowResult> {
  if (paymentMethod === "lightning") {
    return initializeLightning(input, quote, orderId);
  }
  if (paymentMethod === "cashu") {
    return initializeCashu(input, quote, orderId);
  }
  if (paymentMethod === "fiat") {
    return initializeFiat(input, quote, orderId);
  }
  return initializeStripe(input, quote, orderId);
}

async function initializeSubscription(
  input: CreateOrderFlowInput,
  selection: ProductSelection,
  paymentMethod: PaymentMethod
): Promise<OrderFlowResult> {
  const { product, productId, unitPrice, currency, quantity, selectedSpecs } =
    selection;
  const frequency = input.subscriptionFrequency!;

  if (paymentMethod !== "stripe") {
    throw new OrderServiceError(400, {
      error:
        "Recurring Subscribe & Save orders are billed via Stripe. Omit the Bitcoin/fiat paymentMethod (it is set to stripe automatically) to start a subscription.",
    });
  }
  if (!product.subscriptionEnabled) {
    throw new OrderServiceError(400, {
      error: "This product does not offer subscriptions.",
    });
  }
  const allowedFrequencies = Array.isArray(product.subscriptionFrequency)
    ? product.subscriptionFrequency
    : [];
  if (!allowedFrequencies.includes(frequency)) {
    throw new OrderServiceError(400, {
      error: `Invalid subscriptionFrequency "${frequency}" for this product.`,
      availableFrequencies: allowedFrequencies,
    });
  }
  if (input.selectedBulkUnits) {
    throw new OrderServiceError(400, {
      error: "Bulk/bundle pricing cannot be combined with a subscription.",
    });
  }
  if (!input.buyerEmail) {
    throw new OrderServiceError(400, {
      error: "buyerEmail is required to start a subscription.",
    });
  }

  // Reuse the battle-tested web subscription endpoint (Stripe Connect,
  // donation fee, affiliate, idempotency, and the subscriptions-table insert
  // all live there) instead of duplicating that logic on the order path. The
  // self-call mirrors how the MCP order tool already reaches create-order.
  const baseUrl = `http://localhost:${process.env.PORT || 5000}`;
  const productEventId = product.d
    ? `30402:${product.pubkey}:${product.d}`
    : productId;
  const variantInfo =
    Object.keys(selectedSpecs).length > 0 ? selectedSpecs : null;
  const discountPercent = product.subscriptionDiscount || 0;

  const subRes = await fetch(`${baseUrl}/api/stripe/create-subscription`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      customerEmail: input.buyerEmail,
      productTitle: product.title,
      amount: unitPrice,
      currency,
      frequency,
      discountPercent,
      sellerPubkey: product.pubkey,
      buyerPubkey: input.buyerPubkey,
      productEventId,
      quantity,
      variantInfo,
      shippingAddress: input.shippingAddress || null,
    }),
  });

  const data = await subRes.json();
  if (!subRes.ok || !data.success) {
    throw new OrderServiceError(subRes.status >= 400 ? subRes.status : 502, {
      error: "Failed to create subscription",
      details: data.error || data.details || "Unknown error",
    });
  }

  const recurringAmount =
    Math.round(unitPrice * (1 - discountPercent / 100) * quantity * 100) / 100;

  return {
    kind: "subscription",
    subscriptionId: data.subscriptionId,
    frequency,
    status: data.status,
    currentPeriodEnd: data.currentPeriodEnd,
    recurringAmount,
    currency,
    quantity,
    discountPercent,
    clientSecret: data.clientSecret,
    customerId: data.customerId,
    connectedAccountId: data.connectedAccountId || undefined,
  };
}

async function initializeLightning(
  input: CreateOrderFlowInput,
  quote: OrderQuote,
  orderId: string
): Promise<OrderFlowResult> {
  const { product, productId, currency, totalAmount, emailOptions } = quote;
  const quantity = quote.effectiveQuantity;
  const { mintUrl } = input;

  // Ignore any caller-supplied mintUrl entirely: the buyer must not be able to
  // choose which mint the server trusts for Lightning invoice settlement.
  if (mintUrl && !ALLOWED_MINT_URLS.has(mintUrl)) {
    throw new OrderServiceError(400, {
      error:
        "The requested mint is not supported. Omit mintUrl to use the default mint.",
    });
  }
  const mint = DEFAULT_MINT_URL;

  // Fail closed on a fiat→sats conversion with no authoritative rate (see
  // resolveSatsAmount). A sats/BTC price converts deterministically.
  const amountInSats = resolveSatsAmount(currency, totalAmount);

  try {
    const cashuMint = new CashuMint(mint);
    const wallet = new CashuWallet(cashuMint);
    await wallet.loadMint();
    const mintQuote = await wallet.createMintQuoteBolt11(amountInSats);

    const order = await createMcpOrder(
      orderId,
      input.apiKeyId,
      input.buyerPubkey,
      product.pubkey,
      productId,
      product.title,
      quantity,
      totalAmount,
      currency,
      input.buyerEmail || null,
      input.shippingAddress || null,
      `ln_${mintQuote.quote}`
    );

    pendingLightningPayments.set(orderId, {
      quote: mintQuote.quote,
      mintUrl: mint,
      amount: amountInSats,
      orderId,
      productId,
      quantity,
      inventoryVariantKey: quote.inventoryVariantKey || "_default",
      ...(quote.validatedDiscountCode
        ? { discountCode: quote.validatedDiscountCode }
        : {}),
      sellerPubkey: product.pubkey,
    });

    await sendOrderEmail(
      input.buyerEmail || null,
      input.buyerPubkey,
      product,
      orderId,
      totalAmount,
      currency,
      "lightning",
      emailOptions
    );

    return {
      kind: "lightning",
      order,
      bolt11: mintQuote.request,
      quoteId: mintQuote.quote,
      amountSats: amountInSats,
      mintUrl: mint,
      pricingBlock: quote.pricingBlock,
    };
  } catch (error) {
    if (error instanceof OrderServiceError) throw error;
    console.error("Lightning invoice generation failed:", error);
    throw new OrderServiceError(500, {
      error: "Failed to generate Lightning invoice",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

async function initializeCashu(
  input: CreateOrderFlowInput,
  quote: OrderQuote,
  orderId: string
): Promise<OrderFlowResult> {
  const { product, productId, currency, totalAmount, emailOptions } = quote;
  const quantity = quote.effectiveQuantity;
  const { cashuToken } = input;

  if (!cashuToken) {
    throw new OrderServiceError(400, {
      error:
        "cashuToken is required for Cashu payments. Provide a serialized Cashu token string.",
      example: {
        paymentMethod: "cashu",
        cashuToken: "cashuBo2F0...",
      },
    });
  }

  const { getDecodedToken } = await import("@cashu/cashu-ts");
  const decoded = getDecodedToken(cashuToken, []);

  if (!decoded || !decoded.proofs || decoded.proofs.length === 0) {
    throw new OrderServiceError(400, {
      error: "Invalid Cashu token: no proofs found",
    });
  }

  const tokenAmount = decoded.proofs.reduce(
    (sum: number, p: any) => sum + (p.amount || 0),
    0
  );

  // Fail closed on a fiat→sats conversion with no authoritative rate (see
  // resolveSatsAmount). A sats/BTC price converts deterministically.
  const requiredAmount = resolveSatsAmount(currency, totalAmount);

  if (tokenAmount < requiredAmount) {
    throw new OrderServiceError(400, {
      error: "Insufficient Cashu token amount",
      provided: tokenAmount,
      required: requiredAmount,
      currency: "sats",
    });
  }

  const tokenMintUrl = decoded.mint;

  // The token's embedded mint URL must be on the server-controlled allowlist.
  // Accepting a buyer-chosen mint would let an attacker point the server at a
  // fake mint that always reports redemption success, creating fraudulent paid
  // orders and opening SSRF to arbitrary internal endpoints.
  if (!tokenMintUrl || !ALLOWED_MINT_URLS.has(tokenMintUrl)) {
    throw new OrderServiceError(400, {
      error:
        "Cashu token issuer is not a supported mint. Only tokens from trusted mints are accepted.",
      supportedMints: Array.from(ALLOWED_MINT_URLS),
    });
  }

  try {
    const cashuMint = new CashuMint(tokenMintUrl);
    const wallet = new CashuWallet(cashuMint);
    await wallet.loadMint();
    const { withMintRetry } = await import("@/utils/cashu/mint-retry-service");
    await withMintRetry(() => wallet.receive(cashuToken), {
      maxAttempts: 4,
      perAttemptTimeoutMs: 20000,
      totalTimeoutMs: 90000,
    });
  } catch (redeemError) {
    console.error("Cashu token redemption failed:", redeemError);
    throw new OrderServiceError(400, {
      error:
        "Failed to redeem Cashu token. It may be invalid or already spent.",
      details:
        redeemError instanceof Error ? redeemError.message : "Unknown error",
    });
  }

  const order = await createMcpOrder(
    orderId,
    input.apiKeyId,
    input.buyerPubkey,
    product.pubkey,
    productId,
    product.title,
    quantity,
    totalAmount,
    currency,
    input.buyerEmail || null,
    input.shippingAddress || null,
    `cashu_${orderId}`
  );

  await updateOrderPaymentStatus(orderId, "paid");

  // Discount code is consumed only now that the Cashu token has been
  // redeemed and the order is marked paid. If redemption above failed we
  // threw before reaching this point, so an unpaid order never burns a use
  // against the code's max_uses limit.
  if (quote.validatedDiscountCode) {
    try {
      await markDiscountCodeUsed(quote.validatedDiscountCode, product.pubkey);
    } catch (markErr) {
      console.error(
        "Failed to mark discount code used (cashu, post-paid):",
        markErr
      );
    }
  }

  try {
    await deductStock(
      productId,
      quantity,
      orderId,
      quote.inventoryVariantKey || "_default"
    );
  } catch (invErr) {
    console.error("Inventory deduction failed (cashu):", invErr);
  }

  await sendOrderEmail(
    input.buyerEmail || null,
    input.buyerPubkey,
    product,
    orderId,
    totalAmount,
    currency,
    "cashu",
    emailOptions
  );

  return {
    kind: "cashu",
    order,
    tokenAmount,
    requiredAmount,
    change: tokenAmount > requiredAmount ? tokenAmount - requiredAmount : 0,
    pricingBlock: quote.pricingBlock,
  };
}

async function initializeFiat(
  input: CreateOrderFlowInput,
  quote: OrderQuote,
  orderId: string
): Promise<OrderFlowResult> {
  const { product, productId, currency, totalAmount, emailOptions } = quote;
  const quantity = quote.effectiveQuantity;
  const sellerProfile = quote.sellerProfile;
  const { fiatMethod } = input;

  const fiatOptions = sellerProfile?.fiat_options || [];
  if (fiatOptions.length === 0) {
    throw new OrderServiceError(400, {
      error:
        "This seller does not accept fiat payments. Try lightning, cashu, or stripe.",
    });
  }

  if (fiatMethod) {
    const methodExists = fiatOptions.some(
      (opt: string) => opt.toLowerCase() === fiatMethod.toLowerCase()
    );
    if (!methodExists) {
      throw new OrderServiceError(400, {
        error: `Vendor does not accept "${fiatMethod}". Available fiat options: ${fiatOptions.join(
          ", "
        )}`,
      });
    }
  }

  const order = await createMcpOrder(
    orderId,
    input.apiKeyId,
    input.buyerPubkey,
    product.pubkey,
    productId,
    product.title,
    quantity,
    totalAmount,
    currency,
    input.buyerEmail || null,
    input.shippingAddress || null,
    `fiat_${fiatMethod || "unspecified"}_${orderId}`
  );

  try {
    await deductStock(
      productId,
      quantity,
      orderId,
      quote.inventoryVariantKey || "_default"
    );
  } catch (invErr) {
    console.error("Inventory deduction failed (fiat):", invErr);
  }

  await sendOrderEmail(
    input.buyerEmail || null,
    input.buyerPubkey,
    product,
    orderId,
    totalAmount,
    currency,
    fiatMethod || "fiat",
    emailOptions
  );

  return {
    kind: "fiat",
    order,
    fiatOptions,
    selectedMethod: fiatMethod || null,
    sellerContact: {
      name: sellerProfile?.name || sellerProfile?.display_name || null,
      nip05: sellerProfile?.nip05 || null,
    },
    amount: totalAmount,
    currency,
    pricingBlock: quote.pricingBlock,
  };
}

async function initializeStripe(
  input: CreateOrderFlowInput,
  quote: OrderQuote,
  orderId: string
): Promise<OrderFlowResult> {
  const { product, productId, currency, totalAmount, emailOptions } = quote;
  const quantity = quote.effectiveQuantity;

  let paymentIntentId: string | null = null;
  let clientSecret: string | null = null;
  let connectedAccountId: string | null = null;

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (stripeKey) {
    try {
      const stripe = new Stripe(stripeKey, {
        apiVersion: "2025-09-30.clover",
      });

      let amountInCents = Math.ceil(totalAmount * 100);
      if (amountInCents < 50) amountInCents = 50;

      const sellerPubkey = product.pubkey;
      const isPlatformAccount =
        sellerPubkey === process.env.NEXT_PUBLIC_MILK_MARKET_PK;

      if (!isPlatformAccount) {
        const connectAccount = await getStripeConnectAccount(sellerPubkey);
        if (connectAccount && connectAccount.charges_enabled) {
          connectedAccountId = connectAccount.stripe_account_id;
        }
      }

      const stripeOptions = connectedAccountId
        ? { stripeAccount: connectedAccountId }
        : undefined;

      const paymentIntentParams: Stripe.PaymentIntentCreateParams = {
        amount: amountInCents,
        currency: "usd",
        description: `MCP Order: ${product.title}`,
        metadata: {
          orderId,
          productId,
          buyerPubkey: input.buyerPubkey,
          sellerPubkey: product.pubkey,
          source: "mcp",
        },
        automatic_payment_methods: { enabled: true },
      };

      if (input.buyerEmail) {
        paymentIntentParams.receipt_email = input.buyerEmail;
      }

      const paymentIntent = await stripe.paymentIntents.create(
        paymentIntentParams,
        stripeOptions
      );

      paymentIntentId = paymentIntent.id;
      clientSecret = paymentIntent.client_secret;
    } catch (stripeError) {
      console.error("Stripe payment intent creation failed:", stripeError);
      throw new OrderServiceError(500, {
        error: "Failed to create payment intent",
        details:
          stripeError instanceof Error ? stripeError.message : "Unknown error",
      });
    }
  }

  const order = await createMcpOrder(
    orderId,
    input.apiKeyId,
    input.buyerPubkey,
    product.pubkey,
    productId,
    product.title,
    quantity,
    totalAmount,
    currency,
    input.buyerEmail || null,
    input.shippingAddress || null,
    paymentIntentId
  );

  try {
    await deductStock(
      productId,
      quantity,
      orderId,
      quote.inventoryVariantKey || "_default"
    );
  } catch (invErr) {
    console.error("Inventory deduction failed (stripe):", invErr);
  }

  await sendOrderEmail(
    input.buyerEmail || null,
    input.buyerPubkey,
    product,
    orderId,
    totalAmount,
    currency,
    "stripe",
    emailOptions
  );

  return {
    kind: "stripe",
    order,
    paymentIntentId,
    clientSecret,
    connectedAccountId,
    amount: totalAmount,
    currency,
    pricingBlock: quote.pricingBlock,
  };
}

async function updateOrderPaymentStatus(orderId: string, status: string) {
  await updateMcpOrderPayment(orderId, `${status}_${orderId}`, status);
}

export async function sendOrderEmail(
  buyerEmail: string | null,
  buyerPubkey: string,
  product: any,
  orderId: string,
  totalAmount: number,
  currency: string,
  paymentMethod: string,
  options?: {
    shippingAddress?: string | null;
    selectedSize?: string;
    selectedVolume?: string;
    selectedWeight?: string;
    selectedBulkUnits?: number;
    quantity?: number;
  }
) {
  if (!buyerEmail) return;
  try {
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "";
    if (baseUrl) {
      await fetch(`${baseUrl}/api/email/send-order-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          buyerEmail,
          buyerPubkey,
          sellerPubkey: product.pubkey,
          orderId,
          productTitle: product.title,
          amount: totalAmount,
          currency,
          paymentMethod,
          shippingAddress: options?.shippingAddress || undefined,
          selectedSize: options?.selectedSize || undefined,
          selectedVolume: options?.selectedVolume || undefined,
          selectedWeight: options?.selectedWeight || undefined,
          selectedBulkOption: options?.selectedBulkUnits
            ? String(options.selectedBulkUnits)
            : undefined,
          productId: product.id,
          quantity: options?.quantity || 1,
        }),
      });
    }
  } catch (emailError) {
    console.error("Failed to send order email:", emailError);
  }
}
