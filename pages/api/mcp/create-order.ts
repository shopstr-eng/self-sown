import type { NextApiRequest, NextApiResponse } from "next";
import { authenticateRequest, initializeApiKeysTable } from "@/utils/mcp/auth";
import { recordRequest } from "@/utils/mcp/metrics";
import {
  getMcpOrder,
  listMcpOrders,
  formatOrderForResponse,
  CreateOrderInput,
} from "@/mcp/tools/purchase-tools";
import { applyRateLimit } from "@/utils/rate-limit";
import { issueMacaroon, setL402Challenge, buildL402Body } from "@/utils/l402";
import {
  createOrderFlow,
  OrderServiceError,
  pendingLightningPayments,
  type CreateOrderFlowInput,
  type OrderFlowResult,
  type PaymentMethod,
} from "@/utils/ucp/order-service";

// MCP create-order is on the payment critical path; the per-IP cap is
// generous so a buyer cannot accidentally lock themselves out across
// retries, but bounded enough to stop a runaway client from owning the
// mint quote pipeline.
const RATE_LIMIT = { limit: 60, windowMs: 60 * 1000 };
const PER_KEY_LIMIT = { limit: 30, windowMs: 60 * 1000 };

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

  if (!applyRateLimit(req, res, "mcp-create-order:ip", RATE_LIMIT)) {
    recordRequest(Date.now() - requestStart, false, "create-order");
    return;
  }

  await ensureTables();

  const apiKey = await authenticateRequest(req, res, "read_write");
  if (!apiKey) {
    recordRequest(Date.now() - requestStart, false, "create-order");
    return;
  }

  if (
    !applyRateLimit(
      req,
      res,
      "mcp-create-order:key",
      PER_KEY_LIMIT,
      String(apiKey.id)
    )
  ) {
    recordRequest(Date.now() - requestStart, false, "create-order");
    return;
  }

  const originalEnd = res.end.bind(res);
  (res as any).end = function (...args: any[]) {
    const durationMs = Date.now() - requestStart;
    res.setHeader("X-Response-Time", `${durationMs}ms`);
    recordRequest(durationMs, res.statusCode < 500, "create-order");
    return originalEnd(...args);
  };

  if (req.method === "POST") {
    return handleCreateOrder(req, res, apiKey.id, apiKey.pubkey);
  }

  if (req.method === "GET") {
    const { orderId } = req.query;
    if (orderId && typeof orderId === "string") {
      return handleGetOrder(res, orderId, apiKey.pubkey);
    }
    return handleListOrders(req, res, apiKey.pubkey);
  }

  return res.status(405).json({ error: "Method not allowed" });
}

async function handleCreateOrder(
  req: NextApiRequest,
  res: NextApiResponse,
  apiKeyId: number,
  buyerPubkey: string
) {
  const {
    productId,
    quantity = 1,
    buyerEmail,
    shippingAddress,
    selectedSize,
    selectedVolume,
    selectedWeight,
    selectedBulkUnits,
    discountCode,
    paymentMethod = "stripe",
    mintUrl,
    cashuToken,
    fiatMethod,
    subscriptionFrequency,
  } = req.body as CreateOrderInput & {
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
  };

  const input: CreateOrderFlowInput = {
    productId,
    quantity,
    buyerEmail,
    shippingAddress: shippingAddress || null,
    selectedSize,
    selectedVolume,
    selectedWeight,
    selectedBulkUnits,
    discountCode,
    paymentMethod,
    mintUrl,
    cashuToken,
    fiatMethod,
    subscriptionFrequency,
    apiKeyId,
    buyerPubkey,
  };

  let result: OrderFlowResult;
  try {
    result = await createOrderFlow(input);
  } catch (error) {
    if (error instanceof OrderServiceError) {
      return res.status(error.status).json(error.body);
    }
    console.error("Failed to create MCP order:", error);
    return res.status(500).json({
      error: "Failed to create order",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }

  return formatCreateOrderResult(res, result);
}

/**
 * Reproduce the exact legacy MCP HTTP responses from the neutral order-service
 * result. The shapes, status codes, messages, and the L402 challenge header are
 * intentionally byte-for-byte identical to the previous inline handlers so MCP
 * clients (and verify-payment) see no contract change.
 */
function formatCreateOrderResult(
  res: NextApiResponse,
  result: OrderFlowResult
) {
  if (result.kind === "lightning") {
    const orderId = result.order.order_id;
    // L402: attach the standard WWW-Authenticate challenge so agents that
    // speak the L402 protocol can discover how to pay this 402. The macaroon
    // binds the challenge to this order; settlement is confirmed via the mint
    // quote in verify-payment. See /.well-known/l402.json.
    const macaroon = issueMacaroon(orderId, result.amountSats);
    const l402 = { macaroon, invoice: result.bolt11 };
    setL402Challenge(res, l402);

    return res.status(402).json({
      status: "payment_required",
      message:
        "Lightning invoice created. Pay the invoice to complete your order.",
      paymentMethod: "lightning",
      order: formatOrderForResponse(result.order),
      payment: {
        bolt11: result.bolt11,
        quoteId: result.quoteId,
        amount: result.amountSats,
        currency: "sats",
        mintUrl: result.mintUrl,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        instructions: {
          step1: "Pay the bolt11 Lightning invoice using any Lightning wallet",
          step2: `Verify payment: POST /api/mcp/verify-payment with { "orderId": "${orderId}" }`,
          step3:
            "Once the invoice is paid, the order status will update to confirmed",
        },
      },
      l402: buildL402Body(l402),
      pricing: result.pricingBlock,
    });
  }

  if (result.kind === "cashu") {
    return res.status(201).json({
      success: true,
      paymentMethod: "cashu",
      message: "Payment received via Cashu tokens. Order confirmed.",
      order: formatOrderForResponse({
        ...result.order,
        payment_status: "paid",
      }),
      payment: {
        method: "cashu",
        amount: result.tokenAmount,
        required: result.requiredAmount,
        status: "paid",
        change: result.change,
      },
      pricing: result.pricingBlock,
    });
  }

  if (result.kind === "fiat") {
    return res.status(402).json({
      status: "payment_required",
      message:
        "Order created. Complete payment using the seller's fiat payment details below.",
      paymentMethod: "fiat",
      order: formatOrderForResponse(result.order),
      payment: {
        method: "fiat",
        selectedMethod: result.selectedMethod,
        availableMethods: result.fiatOptions,
        amount: result.amount,
        currency: result.currency,
        sellerContact: result.sellerContact,
        instructions: {
          step1: `Send ${result.amount} ${result.currency} via ${
            result.selectedMethod || "one of the available methods"
          } to the seller`,
          step2:
            "Include your order ID in the payment note/memo: " +
            result.order.order_id,
          step3:
            "The seller will manually confirm receipt and update your order status",
        },
      },
      pricing: result.pricingBlock,
    });
  }

  if (result.kind === "subscription") {
    return res.status(402).json({
      status: "payment_required",
      message:
        "Subscription created. Confirm the first payment to activate the recurring order.",
      paymentMethod: "stripe",
      subscription: {
        subscriptionId: result.subscriptionId,
        frequency: result.frequency,
        status: result.status,
        currentPeriodEnd: result.currentPeriodEnd,
        recurringAmount: result.recurringAmount,
        currency: result.currency,
        quantity: result.quantity,
        discountPercent: result.discountPercent || undefined,
      },
      payment: {
        clientSecret: result.clientSecret,
        customerId: result.customerId,
        connectedAccountId: result.connectedAccountId || undefined,
        instructions: {
          step1:
            "Use the clientSecret with Stripe.js or Stripe SDK to confirm the first subscription payment",
          step2:
            "Call stripe.confirmPayment({ clientSecret }) with a valid payment method",
          step3:
            "Once confirmed, the subscription becomes active and renews automatically at the chosen frequency",
          documentationUrl:
            "https://docs.stripe.com/billing/subscriptions/build-subscriptions",
        },
      },
    });
  }

  // result.kind === "stripe"
  if (result.paymentIntentId && result.clientSecret) {
    return res.status(402).json({
      status: "payment_required",
      message:
        "Order created successfully. Payment is required to complete the order.",
      paymentMethod: "stripe",
      order: formatOrderForResponse(result.order),
      payment: {
        amount: result.amount,
        currency: result.currency,
        paymentIntentId: result.paymentIntentId,
        clientSecret: result.clientSecret,
        connectedAccountId: result.connectedAccountId || undefined,
        instructions: {
          step1:
            "Use the clientSecret with Stripe.js or Stripe SDK to confirm the payment",
          step2:
            "Call stripe.confirmPayment({ clientSecret }) with a valid payment method",
          step3:
            "Once payment is confirmed, the order status will be updated automatically",
          documentationUrl: "https://docs.stripe.com/payments/accept-a-payment",
        },
      },
      pricing: result.pricingBlock,
    });
  }

  return res.status(201).json({
    success: true,
    paymentMethod: "stripe",
    order: formatOrderForResponse(result.order),
    payment: null,
    pricing: result.pricingBlock,
  });
}

async function handleGetOrder(
  res: NextApiResponse,
  orderId: string,
  buyerPubkey: string
) {
  try {
    const order = await getMcpOrder(orderId);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    if (order.buyer_pubkey !== buyerPubkey) {
      return res
        .status(403)
        .json({ error: "Not authorized to view this order" });
    }

    return res.status(200).json({
      success: true,
      order: formatOrderForResponse(order),
    });
  } catch (error) {
    console.error("Failed to get MCP order:", error);
    return res.status(500).json({ error: "Failed to get order" });
  }
}

async function handleListOrders(
  req: NextApiRequest,
  res: NextApiResponse,
  buyerPubkey: string
) {
  const limit = Math.min(parseInt(String(req.query.limit || "50")), 100);
  const offset = parseInt(String(req.query.offset || "0"));

  try {
    const orders = await listMcpOrders(buyerPubkey, limit, offset);
    return res.status(200).json({
      success: true,
      orders: orders.map(formatOrderForResponse),
      pagination: { limit, offset, count: orders.length },
    });
  } catch (error) {
    console.error("Failed to list MCP orders:", error);
    return res.status(500).json({ error: "Failed to list orders" });
  }
}

export { pendingLightningPayments };
