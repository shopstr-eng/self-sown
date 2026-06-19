import type { NextApiRequest, NextApiResponse } from "next";
import { applyRateLimit } from "@/utils/rate-limit";
import { authenticateRequest, initializeApiKeysTable } from "@/utils/mcp/auth";
import { fetchAllProductsFromDb } from "@/utils/db/db-service";
import { parseTags } from "@/utils/parsers/product-parser-functions";
import { deriveBaseUrl, resolveHostScope } from "@/utils/ucp/seller-host";
import {
  createOrderFlow,
  OrderServiceError,
  type CreateOrderFlowInput,
  type OrderFlowResult,
  type PaymentMethod,
} from "@/utils/ucp/order-service";
import {
  decodeVariantId,
  formatCheckoutSession,
  initCheckoutSessionsTable,
  insertCheckoutSession,
  listCheckoutSessions,
  makeMessage,
  type CheckoutSessionMessage,
  type CheckoutSessionStatus,
} from "@/utils/ucp/checkout-store";

const RATE_LIMIT = { limit: 60, windowMs: 60 * 1000 };
const PER_KEY_LIMIT = { limit: 30, windowMs: 60 * 1000 };

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

let tablesReady = false;
async function ensureTables() {
  if (!tablesReady) {
    await initializeApiKeysTable();
    await initCheckoutSessionsTable();
    tablesReady = true;
  }
}

/**
 * /api/ucp/checkout/sessions — Universal Commerce Protocol checkout.
 *
 * POST creates AND initializes a checkout session in one call: it validates the
 * product (host-scoped to the seller on a custom domain / self-host), then
 * delegates to the shared order engine (`createOrderFlow`) — the exact same code
 * path the MCP create-order route uses — and records the result as a session
 * with a payment descriptor + `messages[]` timeline. There is no second payment
 * implementation here.
 *
 * GET lists the authenticated key's own sessions.
 *
 * Both verbs require a `read_write` API key (Pro-gated, like MCP ordering).
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");

  if (req.method === "OPTIONS") {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(204).end();
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!applyRateLimit(req, res, "ucp-checkout-sessions:ip", RATE_LIMIT)) return;

  await ensureTables();

  const apiKey = await authenticateRequest(req, res, "read_write");
  if (!apiKey) return;

  if (
    !applyRateLimit(
      req,
      res,
      "ucp-checkout-sessions:key",
      PER_KEY_LIMIT,
      String(apiKey.id)
    )
  ) {
    return;
  }

  const baseUrl = deriveBaseUrl(req);

  if (req.method === "GET") {
    return handleList(req, res, apiKey.pubkey, baseUrl);
  }

  return handleCreate(req, res, apiKey.id, apiKey.pubkey, baseUrl);
}

async function handleList(
  req: NextApiRequest,
  res: NextApiResponse,
  buyerPubkey: string,
  baseUrl: string
) {
  const limit = clampInt(req.query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  try {
    const rows = await listCheckoutSessions(buyerPubkey, limit, offset);
    return res.status(200).json({
      sessions: rows.map((r) => formatCheckoutSession(r, baseUrl)),
      context: {
        pagination: { limit, offset, returned: rows.length },
        links: {
          self: `${baseUrl}/api/ucp/checkout/sessions`,
          discovery: `${baseUrl}/.well-known/ucp`,
        },
      },
    });
  } catch (error) {
    console.error("UCP checkout list error:", error);
    return res.status(500).json({ error: "Failed to list checkout sessions" });
  }
}

async function handleCreate(
  req: NextApiRequest,
  res: NextApiResponse,
  apiKeyId: number,
  buyerPubkey: string,
  baseUrl: string
) {
  const body = (req.body || {}) as Record<string, any>;
  const productId: string = body.productId;

  if (!productId || typeof productId !== "string") {
    return res.status(400).json({ error: "productId is required" });
  }

  // Resolve the host scope and bind the requested product to it FIRST. On a
  // seller's custom domain / self-host instance, a checkout session may only be
  // opened against that seller's own products — never another seller's listing
  // surfaced through their domain. The scope comes from the verified host, not a
  // client-supplied header.
  const { scope, seller, unresolved } = await resolveHostScope(req);
  if (unresolved) {
    return res
      .status(404)
      .json({ error: "No storefront is configured for this domain." });
  }

  let sellerPubkey: string;
  try {
    const allProducts = await fetchAllProductsFromDb();
    const productEvent = allProducts.find((p) => p.id === productId);
    if (!productEvent) {
      return res.status(404).json({ error: "Product not found" });
    }
    const parsed = parseTags(productEvent);
    if (!parsed) {
      return res.status(500).json({ error: "Failed to parse product data" });
    }
    sellerPubkey = parsed.pubkey;
  } catch (error) {
    console.error("UCP checkout product lookup error:", error);
    return res.status(500).json({ error: "Failed to load product" });
  }

  if (scope === "seller" && seller && seller.pubkey !== sellerPubkey) {
    return res
      .status(403)
      .json({ error: "This product is not sold on this storefront." });
  }

  // A UCP client may pick a variant by the catalog's variant id (e.g.
  // "size:1 Gallon") instead of the lower-level selected* fields. Decode it into
  // the order-engine selection; an explicit selected* field still wins.
  let variantSelection: {
    selectedSize?: string;
    selectedVolume?: string;
    selectedWeight?: string;
  } = {};
  if (typeof body.variantId === "string" && body.variantId.trim()) {
    const decoded = decodeVariantId(body.variantId);
    if (!decoded.ok) {
      return res.status(400).json({ error: decoded.error });
    }
    variantSelection = {
      ...(decoded.selectedSize ? { selectedSize: decoded.selectedSize } : {}),
      ...(decoded.selectedVolume
        ? { selectedVolume: decoded.selectedVolume }
        : {}),
      ...(decoded.selectedWeight
        ? { selectedWeight: decoded.selectedWeight }
        : {}),
    };
  }

  const input: CreateOrderFlowInput = {
    productId,
    quantity: typeof body.quantity === "number" ? body.quantity : 1,
    buyerEmail: body.buyerEmail ?? null,
    shippingAddress: body.shippingAddress ?? null,
    selectedSize: body.selectedSize ?? variantSelection.selectedSize,
    selectedVolume: body.selectedVolume ?? variantSelection.selectedVolume,
    selectedWeight: body.selectedWeight ?? variantSelection.selectedWeight,
    selectedBulkUnits: body.selectedBulkUnits,
    discountCode: body.discountCode,
    paymentMethod: (body.paymentMethod as PaymentMethod) || "stripe",
    mintUrl: body.mintUrl,
    cashuToken: body.cashuToken,
    fiatMethod: body.fiatMethod,
    subscriptionFrequency: body.subscriptionFrequency,
    apiKeyId,
    buyerPubkey,
  };

  let result: OrderFlowResult;
  try {
    result = await createOrderFlow(input);
  } catch (error) {
    if (error instanceof OrderServiceError) {
      // Fail-closed conversion failure (e.g. a fiat-priced product paid in sats
      // with no authoritative exchange rate): the order was NOT placed. Surface
      // it as a UCP escalation envelope rather than a bare error, so the agent
      // sees status `requires_escalation` + a severity-tagged message and can
      // pivot to a fiat payment method or ask the seller to re-price.
      if (error.body?.escalate) {
        return res.status(200).json({
          status: "requires_escalation" as CheckoutSessionStatus,
          buyer: { pubkey: buyerPubkey },
          seller: { pubkey: sellerPubkey },
          productId,
          paymentMethod: input.paymentMethod || "stripe",
          error: error.body.error,
          ...(error.body.code ? { code: error.body.code } : {}),
          messages: [
            makeMessage("session_created", "Checkout session created."),
            makeMessage("requires_escalation", error.body.error, "error"),
          ],
          links: { discovery: `${baseUrl}/.well-known/ucp` },
        });
      }
      // Validation / business-rule failure: surface the order engine's exact
      // status + detail and do NOT persist a junk session row.
      return res.status(error.status).json(error.body);
    }
    console.error("UCP checkout createOrderFlow error:", error);
    return res.status(500).json({
      error: "Failed to create checkout session",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }

  const { status, payment, mcpOrderId, amountTotal, currency, messages } =
    describeResult(result);

  try {
    const row = await insertCheckoutSession({
      buyerPubkey,
      sellerPubkey,
      productId,
      apiKeyId,
      mcpOrderId,
      status,
      paymentMethod: input.paymentMethod || "stripe",
      amountTotal,
      currency,
      request: sanitizeRequest(input),
      quote: result.kind === "subscription" ? null : result.pricingBlock,
      payment,
      messages,
    });
    return res.status(201).json(formatCheckoutSession(row, baseUrl));
  } catch (error) {
    console.error("UCP checkout persist error:", error);
    // The order WAS created by the engine; only the session record failed.
    // Return the payment descriptor so the caller can still complete payment.
    return res.status(201).json({
      id: null,
      status,
      buyer: { pubkey: buyerPubkey },
      seller: { pubkey: sellerPubkey },
      productId,
      ...(mcpOrderId ? { orderId: mcpOrderId } : {}),
      paymentMethod: input.paymentMethod || "stripe",
      amount: amountTotal,
      currency,
      payment,
      messages,
      warning: "Session record could not be persisted; payment is still valid.",
    });
  }
}

/**
 * Translate the neutral order-engine result into the session's status, payment
 * descriptor, and opening timeline. Cashu settles synchronously, so the session
 * is already `completed`; every other method has the payment descriptor ready
 * and the buyer/agent an action to take, so it opens `ready_for_complete` and is
 * driven to `completed` via POST …/complete (or read-time reconciliation).
 */
function describeResult(result: OrderFlowResult): {
  status: CheckoutSessionStatus;
  payment: Record<string, any>;
  mcpOrderId: string | null;
  amountTotal: number;
  currency: string;
  messages: CheckoutSessionMessage[];
} {
  const created = makeMessage("session_created", "Checkout session created.");

  if (result.kind === "lightning") {
    return {
      status: "ready_for_complete",
      mcpOrderId: result.order.order_id,
      amountTotal: Number(result.order.amount_total),
      currency: result.order.currency,
      payment: {
        method: "lightning",
        bolt11: result.bolt11,
        quoteId: result.quoteId,
        amount: result.amountSats,
        currency: "sats",
        mintUrl: result.mintUrl,
        verifyUrl: "/api/mcp/verify-payment",
      },
      messages: [
        created,
        makeMessage(
          "ready_for_complete",
          "Pay the Lightning invoice, then it will confirm automatically."
        ),
      ],
    };
  }

  if (result.kind === "cashu") {
    return {
      status: "completed",
      mcpOrderId: result.order.order_id,
      amountTotal: Number(result.order.amount_total),
      currency: result.order.currency,
      payment: {
        method: "cashu",
        amount: result.tokenAmount,
        required: result.requiredAmount,
        change: result.change,
        status: "paid",
      },
      messages: [
        created,
        makeMessage("completed", "Cashu token redeemed. Order confirmed."),
      ],
    };
  }

  if (result.kind === "fiat") {
    return {
      status: "ready_for_complete",
      mcpOrderId: result.order.order_id,
      amountTotal: Number(result.order.amount_total),
      currency: result.order.currency,
      payment: {
        method: "fiat",
        selectedMethod: result.selectedMethod,
        availableMethods: result.fiatOptions,
        amount: result.amount,
        currency: result.currency,
        sellerContact: result.sellerContact,
      },
      messages: [
        created,
        makeMessage(
          "ready_for_complete",
          "Send fiat payment to the seller using the details provided; the seller confirms receipt."
        ),
      ],
    };
  }

  if (result.kind === "subscription") {
    return {
      status: "ready_for_complete",
      mcpOrderId: null,
      amountTotal: result.recurringAmount,
      currency: result.currency,
      payment: {
        method: "stripe",
        type: "subscription",
        subscriptionId: result.subscriptionId,
        frequency: result.frequency,
        clientSecret: result.clientSecret,
        customerId: result.customerId,
        connectedAccountId: result.connectedAccountId,
        recurringAmount: result.recurringAmount,
        currency: result.currency,
      },
      messages: [
        created,
        makeMessage(
          "ready_for_complete",
          "Confirm the first payment with the clientSecret to activate the subscription."
        ),
      ],
    };
  }

  // result.kind === "stripe"
  return {
    status: "ready_for_complete",
    mcpOrderId: result.order.order_id,
    amountTotal: Number(result.order.amount_total),
    currency: result.order.currency,
    payment: {
      method: "stripe",
      amount: result.amount,
      currency: result.currency,
      paymentIntentId: result.paymentIntentId,
      clientSecret: result.clientSecret,
      connectedAccountId: result.connectedAccountId,
    },
    messages: [
      created,
      makeMessage(
        "ready_for_complete",
        "Confirm the Stripe payment with the clientSecret to complete the order."
      ),
    ],
  };
}

/** Persist a redacted copy of the request — never store raw payment secrets. */
function sanitizeRequest(input: CreateOrderFlowInput): Record<string, any> {
  return {
    productId: input.productId,
    quantity: input.quantity,
    paymentMethod: input.paymentMethod,
    selectedSize: input.selectedSize,
    selectedVolume: input.selectedVolume,
    selectedWeight: input.selectedWeight,
    selectedBulkUnits: input.selectedBulkUnits,
    fiatMethod: input.fiatMethod,
    subscriptionFrequency: input.subscriptionFrequency,
    hasDiscountCode: Boolean(input.discountCode),
    hasShippingAddress: Boolean(input.shippingAddress),
    hasBuyerEmail: Boolean(input.buyerEmail),
  };
}

function clampInt(v: unknown, dflt: number, min: number, max: number): number {
  const n = parseInt(typeof v === "string" ? v : "", 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(n, min), max);
}
