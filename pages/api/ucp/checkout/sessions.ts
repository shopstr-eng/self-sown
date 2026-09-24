import type { NextApiRequest, NextApiResponse } from "next";
import { applyRateLimit } from "@/utils/rate-limit";
import { authenticateRequest, initializeApiKeysTable } from "@/utils/mcp/auth";
import { fetchAllProductsFromDb } from "@/utils/db/db-service";
import { parseTags } from "@/utils/parsers/product-parser-functions";
import { deriveBaseUrl, resolveHostScope } from "@/utils/ucp/seller-host";
import { isSchemaEmail } from "@/utils/ucp/email-format";
import {
  createOrderFlow,
  OrderServiceError,
  VALID_METHODS,
  type CreateOrderFlowInput,
  type OrderFlowResult,
  type PaymentMethod,
} from "@/utils/ucp/order-service";
import {
  decodeVariantId,
  describeResult,
  formatCheckoutSession,
  formatEphemeralCheckoutSession,
  generateCheckoutSessionId,
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

  // The WHOLE remaining body — rate limit, table init, auth, and dispatch —
  // sits inside one try/catch. Table init and auth hit the DB directly, so an
  // outage in any preamble step must also resolve as the route's clean 500
  // JSON instead of an unhandled rejection. (The rate limiter itself fails
  // open on store errors by design.)
  try {
    if (
      !(await applyRateLimit(req, res, "ucp-checkout-sessions:ip", RATE_LIMIT))
    )
      return;

    await ensureTables();

    const apiKey = await authenticateRequest(req, res, "read_write");
    if (!apiKey) return;

    if (
      !(await applyRateLimit(
        req,
        res,
        "ucp-checkout-sessions:key",
        PER_KEY_LIMIT,
        String(apiKey.id)
      ))
    ) {
      return;
    }

    const baseUrl = deriveBaseUrl(req);

    // AWAIT + try/catch, not bare return: without the await an async throw
    // inside a helper escapes any try/catch here as an unhandled rejection
    // instead of becoming a clean 500 JSON response.
    if (req.method === "GET") {
      return await handleList(req, res, apiKey.pubkey, baseUrl);
    }

    return await handleCreate(req, res, apiKey.id, apiKey.pubkey, baseUrl);
  } catch (error) {
    console.error("UCP checkout sessions handler error:", error);
    return res
      .status(500)
      .json({ error: "Failed to process checkout session request" });
  }
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

  // quantity must be a JSON number when present. A mistyped value ("5",
  // "5.0", null, an array, ...) must NOT silently default to 1 — the buyer
  // would be under-charged and under-delivered with no signal. Only an
  // omitted quantity means "one"; the order engine rejects non-integer /
  // out-of-range real numbers.
  if (body.quantity !== undefined && typeof body.quantity !== "number") {
    return res
      .status(400)
      .json({ error: "quantity must be a number (e.g. 2), not a string" });
  }

  // The published request schema (schemas/checkout-session-create.json)
  // restricts paymentMethod to VALID_METHODS; an agent that trusts the schema
  // and one that doesn't must get the same accept/reject answer. Enforce it
  // here too — note "" is rejected rather than falling through `|| "stripe"`,
  // since a blank value is a client bug, not an omission.
  if (
    body.paymentMethod !== undefined &&
    (typeof body.paymentMethod !== "string" ||
      !(VALID_METHODS as string[]).includes(body.paymentMethod))
  ) {
    return res.status(400).json({
      error: `paymentMethod must be one of: ${VALID_METHODS.join(", ")}`,
    });
  }

  // Same parity for buyerEmail: the schema declares format "email", so reject
  // a malformed (or non-string / null) address here instead of letting it
  // reach Stripe's receipt_email or the order-email send and fail later. The
  // check is byte-identical to the ajv-formats `email` format schema-aware
  // clients pre-validate with (see utils/ucp/email-format.ts).
  if (body.buyerEmail !== undefined && !isSchemaEmail(body.buyerEmail)) {
    return res
      .status(400)
      .json({ error: "buyerEmail must be a valid email address" });
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
    quantity: body.quantity ?? 1,
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
        // No order was placed, but the escalation IS persisted as a
        // requires_escalation session row (error + engine code, no order id)
        // so an agent that comes back later can resolve the self link and
        // find the attempt in its session list instead of a bare 404.
        const escalationError =
          typeof error.body.error === "string"
            ? error.body.error
            : "Checkout could not be completed automatically.";
        const escalationCode =
          typeof error.body.code === "string" ? error.body.code : null;
        // The engine tells us the product's price currency on this failure;
        // there is no total to record alongside it.
        const escalationCurrency =
          typeof error.body.currency === "string"
            ? error.body.currency.toLowerCase()
            : "usd";
        const messages: CheckoutSessionMessage[] = [
          makeMessage("session_created", "Checkout session created."),
          makeMessage("requires_escalation", escalationError, "error"),
        ];
        const sessionId = generateCheckoutSessionId();
        try {
          const row = await insertCheckoutSession({
            id: sessionId,
            buyerPubkey,
            sellerPubkey,
            productId,
            apiKeyId,
            mcpOrderId: null,
            status: "requires_escalation" as CheckoutSessionStatus,
            paymentMethod: input.paymentMethod || "stripe",
            amountTotal: 0,
            currency: escalationCurrency,
            request: sanitizeRequest(input),
            quote: null,
            payment: null,
            messages,
            error: escalationError,
            code: escalationCode,
          });
          return res.status(200).json(formatCheckoutSession(row, baseUrl));
        } catch (persistError) {
          console.error("UCP checkout escalation persist error:", persistError);
          // The response must still validate against the published
          // checkout-session schema: the schema conditionally relaxes
          // amount/currency/payment ONLY for `requires_escalation` (and
          // requires `error` there instead). The warning explains why the
          // self link will 404.
          return res.status(200).json(
            formatEphemeralCheckoutSession(
              {
                id: sessionId,
                status: "requires_escalation" as CheckoutSessionStatus,
                buyerPubkey,
                sellerPubkey,
                productId,
                paymentMethod: input.paymentMethod || "stripe",
                payment: null,
                currency: escalationCurrency,
                messages,
                error: escalationError,
                code: escalationCode,
                warning:
                  "Session record could not be persisted; this escalation will not appear in your session list.",
              },
              baseUrl
            )
          );
        }
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

  // Mint the session id up front so the persist-failure fallback below can
  // return the SAME id the insert would have used — the fallback body must
  // still validate against the published checkout-session schema, which
  // requires a string id.
  const sessionId = generateCheckoutSessionId();
  try {
    const row = await insertCheckoutSession({
      id: sessionId,
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
    // Return the full payment descriptor so the caller can still complete
    // payment. The body stays schema-valid via the ephemeral formatter; the
    // warning explains why the self link will 404.
    return res.status(201).json(
      formatEphemeralCheckoutSession(
        {
          id: sessionId,
          status,
          buyerPubkey,
          sellerPubkey,
          productId,
          mcpOrderId,
          paymentMethod: input.paymentMethod || "stripe",
          amountTotal,
          currency,
          payment,
          messages,
          warning:
            "Session record could not be persisted; payment is still valid.",
        },
        baseUrl
      )
    );
  }
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
