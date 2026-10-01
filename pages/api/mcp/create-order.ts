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
  X402_HEADERS,
  X402_HTTP_BOUND_HEADERS,
  X402_LNBTC_MAINNET,
  X402_PROFILE_MCP,
} from "@/utils/x402/constants";
import { computeHttpRequestHash } from "@/utils/x402/request-binding";
import {
  buildPaymentRequired,
  validatePaymentPayload,
  type X402RequestContext,
} from "@/utils/x402/server";
import { decodeBolt11 } from "@/utils/x402/bolt11";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodeSettlementHeader,
} from "@/utils/x402/types";
import {
  claimX402Settlement,
  getX402Settlement,
} from "@/utils/db/x402-service";
import { getPendingLightningQuoteByPaymentHash } from "@/mcp/tools/purchase-tools";
import { runLightningSettlementTail } from "@/utils/mcp/lightning-settlement";
import { getSiteUrl } from "@/utils/site-url";
import {
  createOrderFlow,
  OrderServiceError,
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

// Loopback-only trust channel: the MCP tool handler (pages/api/mcp/index.ts)
// loops back into this route and supplies the mcp:1 request binding it
// computed from the original tools/call. A public client must never get to
// choose its own binding, so these headers are honored ONLY when the
// connection genuinely originates from this server.
const X402_INTERNAL_HEADERS = {
  profile: "x-x402-profile",
  requestHash: "x-x402-request-hash",
  profileParams: "x-x402-profile-params",
} as const;
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function resolveX402Context(
  req: NextApiRequest,
  productId: string
): X402RequestContext {
  const description = `SelfSown marketplace order for product ${productId}`;
  const remote = req.socket?.remoteAddress ?? "";
  const profileHeader = req.headers[X402_INTERNAL_HEADERS.profile];
  const hashHeader = req.headers[X402_INTERNAL_HEADERS.requestHash];
  const paramsHeader = req.headers[X402_INTERNAL_HEADERS.profileParams];
  const profileValue = Array.isArray(profileHeader)
    ? profileHeader[0]
    : profileHeader;
  const hashValue = Array.isArray(hashHeader) ? hashHeader[0] : hashHeader;
  const paramsValue = Array.isArray(paramsHeader)
    ? paramsHeader[0]
    : paramsHeader;

  if (
    LOOPBACK_ADDRESSES.has(remote) &&
    profileValue === X402_PROFILE_MCP &&
    typeof hashValue === "string" &&
    /^[0-9a-f]{64}$/.test(hashValue) &&
    typeof paramsValue === "string"
  ) {
    try {
      const profileParams = JSON.parse(paramsValue);
      if (
        profileParams &&
        typeof profileParams === "object" &&
        typeof profileParams.server === "string" &&
        Array.isArray(profileParams.metadata)
      ) {
        return {
          requestHash: hashValue,
          profile: X402_PROFILE_MCP,
          profileParams,
          resourceUrl: `${getSiteUrl()}/api/mcp`,
          description,
        };
      }
    } catch {
      // fall through to the http:1 binding
    }
  }

  // http:1 binding from the actual request. Documented deviation: the body
  // hash covers JCS(parsed body) rather than the raw content bytes, because
  // Next.js parses JSON before the route runs; identical whenever the client
  // sends canonical JSON.
  const url = `${getSiteUrl()}${req.url ?? "/api/mcp/create-order"}`;
  const headers: Record<string, string | undefined> = {};
  for (const name of X402_HTTP_BOUND_HEADERS) {
    const value = req.headers[name];
    headers[name] = Array.isArray(value) ? value[0] : value;
  }
  const { requestHash, params } = computeHttpRequestHash({
    method: req.method ?? "POST",
    url,
    bodyJson: req.body ?? null,
    headers,
    boundHeaders: [...X402_HTTP_BOUND_HEADERS],
  });
  return {
    requestHash,
    profile: "http:1",
    profileParams: params,
    resourceUrl: url,
    description,
  };
}

/**
 * x402 paid-retry settlement: the client paid the invoice from the original
 * 402 challenge and retried with a PAYMENT-SIGNATURE header carrying the
 * preimage. Validate the proof against server-side expectations, atomically
 * record the payment hash (replay protection), then run the shared Lightning
 * settlement tail (mark paid, discount, stock).
 */
async function handleX402Settlement(
  req: NextApiRequest,
  res: NextApiResponse,
  apiKeyId: number,
  buyerPubkey: string,
  context: X402RequestContext
) {
  const header = req.headers[X402_HEADERS.paymentSignature];
  const raw = Array.isArray(header) ? header[0] : header;
  const payload = raw ? decodePaymentSignatureHeader(raw) : null;
  if (!payload) {
    return res.status(402).json({
      error: "invalid_payment_payload",
      message:
        "PAYMENT-SIGNATURE must be a base64-encoded x402 v2 payment payload.",
    });
  }

  // Locate the order from the PAID invoice's payment hash — the only
  // client-supplied identifier we trust, and only as a lookup key.
  let paymentHash: string;
  try {
    paymentHash = decodeBolt11(
      payload.accepted?.extra?.invoice ?? ""
    ).paymentHash;
  } catch {
    return res.status(402).json({
      error: "invalid_invoice",
      message: "The payload's accepted invoice is not a valid BOLT11 invoice.",
    });
  }

  // Idempotent retry: this invoice already started settling (via an earlier
  // x402 retry or the polling route). The claim row alone is NOT proof of a
  // paid order — a crash between claiming and the settlement tail leaves a
  // row with an unpaid order — so success requires the order to actually be
  // paid. A claim with an unpaid order is a recovery case: fall through and
  // finish the (idempotent) settlement tail.
  const prior = await getX402Settlement(paymentHash);
  let recovering = false;
  if (prior?.orderId) {
    const priorOrder = await getMcpOrder(prior.orderId);
    if (priorOrder && priorOrder.buyer_pubkey !== buyerPubkey) {
      return res
        .status(403)
        .json({ error: "Not authorized to settle this order" });
    }
    if (priorOrder?.payment_status === "paid") {
      res.setHeader(
        X402_HEADERS.paymentResponse,
        encodeSettlementHeader({
          success: true,
          transaction: paymentHash,
          network: X402_LNBTC_MAINNET,
        })
      );
      return res.status(200).json({
        success: true,
        status: "paid",
        message: "Payment has already been confirmed.",
        orderId: prior.orderId,
        order: formatOrderForResponse(priorOrder),
      });
    }
    recovering = true;
  }

  const pending = await getPendingLightningQuoteByPaymentHash(paymentHash);
  if (!pending) {
    return res.status(402).json({
      error: "unknown_payment_hash",
      message:
        "No pending payment matches this invoice. Request a fresh challenge.",
    });
  }

  const order = await getMcpOrder(pending.orderId);
  if (!order) {
    return res.status(404).json({ error: "Order not found" });
  }
  if (order.buyer_pubkey !== buyerPubkey) {
    return res
      .status(403)
      .json({ error: "Not authorized to settle this order" });
  }
  if (order.payment_status === "paid") {
    res.setHeader(
      X402_HEADERS.paymentResponse,
      encodeSettlementHeader({
        success: true,
        transaction: paymentHash,
        network: X402_LNBTC_MAINNET,
      })
    );
    return res.status(200).json({
      success: true,
      status: "paid",
      message: "Payment has already been confirmed.",
      orderId: pending.orderId,
      order: formatOrderForResponse(order),
    });
  }

  // Settle ONLY against the persisted challenge: the exact invoice issued
  // for this quote. Without this, a client could substitute a freshly
  // signed invoice carrying the same payment hash but a different request
  // commitment (or different terms) and have it accepted.
  const submittedInvoice = payload.accepted?.extra?.invoice;
  if (!pending.invoice || submittedInvoice !== pending.invoice) {
    return res.status(402).json({
      error: "invoice_mismatch",
      message:
        "The submitted invoice does not match the one issued for this payment. Retry with the invoice from the original challenge.",
      orderId: pending.orderId,
    });
  }

  const validation = validatePaymentPayload({
    payload,
    expectedAmountMsat: BigInt(pending.amount) * 1000n,
    // The persisted request hash is authoritative (the challenge was bound
    // at issuance); the recomputed one is only a fallback for rows written
    // before the column existed.
    expectedRequestHash: pending.requestHash ?? context.requestHash,
    // Seller-authority (LNbits) invoices embed the request hash in the
    // invoice itself, so strict binding is enforceable; platform-mint
    // invoices are bound server-side via this persisted quote row instead.
    strictBinding: pending.authority === "lnbits",
  });
  if (!validation.ok) {
    return res.status(402).json({
      error: validation.reason,
      message:
        "The submitted x402 payment proof failed validation. Request a fresh challenge before retrying.",
      orderId: pending.orderId,
    });
  }

  // Replay protection BEFORE any side effect: exactly one caller may settle a
  // given payment hash, across retries, instances, and restarts. When a prior
  // claim exists but left the order unpaid (crash between claim and tail),
  // skip re-claiming and finish the idempotent tail below instead.
  const claimed = recovering
    ? true
    : await claimX402Settlement({
        paymentHash,
        network: X402_LNBTC_MAINNET,
        amountMsat: validation.amountMsat,
        orderId: pending.orderId,
        apiKeyId,
        buyerPubkey,
      });
  if (!claimed) {
    const fresh = await getMcpOrder(pending.orderId);
    if (fresh?.payment_status === "paid") {
      res.setHeader(
        X402_HEADERS.paymentResponse,
        encodeSettlementHeader({
          success: true,
          transaction: paymentHash,
          network: X402_LNBTC_MAINNET,
        })
      );
      return res.status(200).json({
        success: true,
        status: "paid",
        message: "Payment has already been confirmed.",
        orderId: pending.orderId,
        order: formatOrderForResponse(fresh),
      });
    }
    return res.status(402).json({
      error: "duplicate_settlement",
      message:
        "This payment is already being settled. Poll verify-payment for the result.",
      orderId: pending.orderId,
    });
  }

  const won = await runLightningSettlementTail(pending, `x402_${paymentHash}`);
  if (!won) {
    const fresh = await getMcpOrder(pending.orderId);
    if (fresh?.payment_status === "paid") {
      res.setHeader(
        X402_HEADERS.paymentResponse,
        encodeSettlementHeader({
          success: true,
          transaction: paymentHash,
          network: X402_LNBTC_MAINNET,
        })
      );
      return res.status(200).json({
        success: true,
        status: "paid",
        message: "Payment has already been confirmed.",
        orderId: pending.orderId,
        order: formatOrderForResponse(fresh),
      });
    }
    return res.status(200).json({
      success: true,
      status: "unpaid",
      message:
        "Payment received; confirmation is in progress. Poll verify-payment.",
      orderId: pending.orderId,
    });
  }

  const settledOrder = await getMcpOrder(pending.orderId);
  res.setHeader(
    X402_HEADERS.paymentResponse,
    encodeSettlementHeader({
      success: true,
      transaction: paymentHash,
      network: X402_LNBTC_MAINNET,
    })
  );
  return res.status(200).json({
    success: true,
    status: "paid",
    message: "x402 Lightning payment settled. Your order is confirmed.",
    paymentMethod: "lightning",
    orderId: pending.orderId,
    ...(settledOrder ? { order: formatOrderForResponse(settledOrder) } : {}),
    payment: {
      method: "lightning",
      amount: pending.amount,
      currency: "sats",
      quoteId: pending.quote,
    },
    x402: {
      settled: true,
      network: X402_LNBTC_MAINNET,
      transaction: paymentHash,
    },
  });
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const requestStart = Date.now();

  // The WHOLE handler body — rate limit, table init, auth, and dispatch — sits
  // inside one try/catch. Table init and auth hit the DB directly, so an
  // outage in any preamble step must also resolve as the route's clean 500
  // JSON instead of an unhandled rejection. (The rate limiter itself fails
  // open on store errors by design.)
  try {
    if (!(await applyRateLimit(req, res, "mcp-create-order:ip", RATE_LIMIT))) {
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
      !(await applyRateLimit(
        req,
        res,
        "mcp-create-order:key",
        PER_KEY_LIMIT,
        String(apiKey.id)
      ))
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

    // AWAIT + try/catch, not bare return: without the await an async throw
    // inside a helper escapes any try/catch here as an unhandled rejection
    // instead of becoming a clean 500 JSON response.
    if (req.method === "POST") {
      return await handleCreateOrder(req, res, apiKey.id, apiKey.pubkey);
    }

    if (req.method === "GET") {
      const { orderId } = req.query;
      if (orderId && typeof orderId === "string") {
        return await handleGetOrder(res, orderId, apiKey.pubkey);
      }
      return await handleListOrders(req, res, apiKey.pubkey);
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    console.error("MCP create-order handler error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
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

  const x402Context = resolveX402Context(req, productId);

  // x402 paid retry: the client already paid a challenge invoice and submits
  // the preimage proof instead of starting a new order.
  if (req.headers[X402_HEADERS.paymentSignature]) {
    // try/catch so `return await` is legal (return-await: in-try-catch) and
    // async throws can't escape as unhandled rejections.
    try {
      return await handleX402Settlement(
        req,
        res,
        apiKeyId,
        buyerPubkey,
        x402Context
      );
    } catch (error) {
      console.error("x402 settlement failed:", error);
      return res.status(500).json({
        error: "Failed to settle x402 payment",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

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
    x402: x402Context,
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

  return formatCreateOrderResult(res, result, x402Context);
}

/**
 * Reproduce the exact legacy MCP HTTP responses from the neutral order-service
 * result. The shapes, status codes, messages, and the L402 challenge header are
 * intentionally byte-for-byte identical to the previous inline handlers so MCP
 * clients (and verify-payment) see no contract change.
 */
function formatCreateOrderResult(
  res: NextApiResponse,
  result: OrderFlowResult,
  x402Context?: X402RequestContext
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

    // x402 v2 (`exact` scheme, `lnbtc` network): the same invoice is also
    // advertised as an x402 PaymentRequired — PAYMENT-REQUIRED header plus an
    // `x402` body block for clients that don't read headers. Paying agents
    // retry this same request with a PAYMENT-SIGNATURE header carrying the
    // preimage; paying via a wallet and polling verify-payment still works.
    let x402Block;
    if (result.x402Requirement && x402Context) {
      x402Block = buildPaymentRequired({
        requirement: result.x402Requirement,
        context: x402Context,
      });
      res.setHeader(
        X402_HEADERS.paymentRequired,
        encodePaymentRequiredHeader(x402Block)
      );
    }

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
        // Real invoice expiry from the mint quote / bolt11 itself (resolved in
        // order-service), so agents don't abandon a payable invoice early or
        // retry an expired one against a fabricated 10-minute deadline.
        expiresAt: result.expiresAt,
        instructions: {
          step1: "Pay the bolt11 Lightning invoice using any Lightning wallet",
          step2: `Verify payment: POST /api/mcp/verify-payment with { "orderId": "${orderId}" } — or retry this request with a PAYMENT-SIGNATURE header carrying the x402 preimage payload`,
          step3:
            "Once the invoice is paid, the order status will update to confirmed",
        },
      },
      l402: buildL402Body(l402),
      ...(x402Block ? { x402: x402Block } : {}),
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
  callerPubkey: string
) {
  try {
    const order = await getMcpOrder(orderId);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    // Buyer OR seller may read the order; a third party's key still gets 403.
    if (
      order.buyer_pubkey !== callerPubkey &&
      order.seller_pubkey !== callerPubkey
    ) {
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
  // parseInt("abc") is NaN, which Postgres rejects in LIMIT/OFFSET — clamp
  // malformed pagination to safe defaults instead of 500ing.
  const parsedLimit = parseInt(String(req.query.limit ?? "50"), 10);
  const parsedOffset = parseInt(String(req.query.offset ?? "0"), 10);
  const limit = Number.isNaN(parsedLimit)
    ? 50
    : Math.min(Math.max(parsedLimit, 1), 100);
  const offset =
    Number.isNaN(parsedOffset) || parsedOffset < 0 ? 0 : parsedOffset;

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
