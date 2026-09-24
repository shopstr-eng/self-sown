import type { NextApiRequest, NextApiResponse } from "next";
import { applyRateLimit } from "@/utils/rate-limit";
import { authenticateRequest, initializeApiKeysTable } from "@/utils/mcp/auth";
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
  claimCheckoutSessionRetry,
  describeResult,
  failCheckoutSessionRetry,
  formatCheckoutSession,
  getCheckoutSession,
  initCheckoutSessionsTable,
  makeMessage,
  rescueCheckoutSessionRetry,
  resolveCheckoutSessionRetry,
  type CheckoutSessionMessage,
  type CheckoutSessionRow,
} from "@/utils/ucp/checkout-store";

const RATE_LIMIT = { limit: 60, windowMs: 60 * 1000 };
const PER_KEY_LIMIT = { limit: 30, windowMs: 60 * 1000 };

let tablesReady = false;
async function ensureTables() {
  if (!tablesReady) {
    await initializeApiKeysTable();
    await initCheckoutSessionsTable();
    tablesReady = true;
  }
}

/**
 * POST /api/ucp/checkout/sessions/[id]/retry — resume an escalated session.
 *
 * A PRE-ORDER escalation (requires_escalation, no order placed — e.g. a sats
 * payment on a fiat-priced product with no live exchange rate) can be retried
 * with a different payment method instead of opening a brand-new session, so
 * the agent keeps ONE timeline instead of a trail of dead sessions. The order
 * details (product, quantity, variant selection) come from the session's
 * stored (redacted) request; payment secrets and PII that were never persisted
 * (buyerEmail, shippingAddress, discountCode, mintUrl, cashuToken) must be
 * re-supplied in the retry body when the new method needs them.
 *
 * Owner-only (not-found and not-owned both 404). Only requires_escalation
 * sessions with no order are retriable; anything else is a 409. The claim is
 * atomic (requires_escalation → incomplete in one UPDATE) so two concurrent
 * retries can't double-create an order, and every engine outcome settles the
 * claim — success writes the new descriptor, a repeat escalation lands back on
 * requires_escalation with the fresh error/code.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");

  if (req.method === "OPTIONS") {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(204).end();
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // One try/catch around the whole body, mirroring /sessions: table init and
  // auth hit the DB directly, so a preamble outage must still resolve as the
  // route's clean 500 JSON instead of an unhandled rejection.
  try {
    if (!(await applyRateLimit(req, res, "ucp-checkout-retry:ip", RATE_LIMIT)))
      return;

    await ensureTables();

    const apiKey = await authenticateRequest(req, res, "read_write");
    if (!apiKey) return;

    if (
      !(await applyRateLimit(
        req,
        res,
        "ucp-checkout-retry:key",
        PER_KEY_LIMIT,
        String(apiKey.id)
      ))
    ) {
      return;
    }

    const id = typeof req.query.id === "string" ? req.query.id : "";
    if (!id) {
      return res.status(400).json({ error: "Session id is required" });
    }

    const baseUrl = deriveBaseUrl(req);
    return await handleRetry(req, res, id, apiKey, baseUrl);
  } catch (error) {
    console.error("UCP checkout retry handler error:", error);
    return res
      .status(500)
      .json({ error: "Failed to retry checkout session" });
  }
}

async function handleRetry(
  req: NextApiRequest,
  res: NextApiResponse,
  id: string,
  apiKey: { id: number; pubkey: string },
  baseUrl: string
) {
  const body = (req.body || {}) as Record<string, any>;

  // paymentMethod is the point of a retry. When omitted it defaults to the
  // session's last attempted method (a transient cause, e.g. an exchange-rate
  // outage, may have cleared); when present it must be a real method — "" is
  // rejected rather than falling through, since a blank value is a client bug.
  if (
    body.paymentMethod !== undefined &&
    (typeof body.paymentMethod !== "string" ||
      !(VALID_METHODS as string[]).includes(body.paymentMethod))
  ) {
    return res.status(400).json({
      error: `paymentMethod must be one of: ${VALID_METHODS.join(", ")}`,
    });
  }

  // buyerEmail was redacted from the stored request, so a retry that needs it
  // must re-supply it — with the same schema-email parity check as creation.
  if (body.buyerEmail !== undefined && !isSchemaEmail(body.buyerEmail)) {
    return res
      .status(400)
      .json({ error: "buyerEmail must be a valid email address" });
  }

  const row = await getCheckoutSession(id);
  // Same 404 for missing and not-owned: don't reveal another key's sessions.
  if (!row || row.buyer_pubkey !== apiKey.pubkey) {
    return res.status(404).json({ error: "Checkout session not found" });
  }

  if (row.status !== "requires_escalation") {
    return res.status(409).json({
      error: `Only a session in requires_escalation can be retried; this session is ${row.status}.`,
    });
  }

  // A POST-order escalation already has a real order (payment failed after
  // creation); retrying it here would place a SECOND order. That path needs
  // cancel/refund semantics, which retry deliberately does not attempt.
  if (row.mcp_order_id) {
    return res.status(409).json({
      error:
        "This session's order was already placed before it escalated; open a new checkout session instead of retrying.",
    });
  }

  // The session was scoped to the host it was created on; a retry must satisfy
  // the same binding — on a seller's custom domain, only that seller's
  // sessions can be retried through it.
  const { scope, seller, unresolved } = await resolveHostScope(req);
  if (unresolved) {
    return res
      .status(404)
      .json({ error: "No storefront is configured for this domain." });
  }
  if (scope === "seller" && seller && seller.pubkey !== row.seller_pubkey) {
    return res
      .status(403)
      .json({ error: "This session is not for this storefront." });
  }

  // Atomic claim: only ONE concurrent retry proceeds to the order engine; the
  // loser sees a 409 instead of a duplicate order.
  const claimed = await claimCheckoutSessionRetry(id, apiKey.pubkey);
  if (!claimed) {
    return res.status(409).json({
      error:
        "This session is already being retried or is no longer in requires_escalation.",
    });
  }

  const stored = (claimed.request || {}) as Record<string, any>;
  const paymentMethod: PaymentMethod =
    (body.paymentMethod as PaymentMethod) ||
    (claimed.payment_method as PaymentMethod);

  // Order details come from the session's stored request; secrets/PII that
  // were never persisted (buyerEmail, shippingAddress, discountCode, mintUrl,
  // cashuToken) come only from this retry's body.
  const input: CreateOrderFlowInput = {
    productId: claimed.product_id,
    quantity: typeof stored.quantity === "number" ? stored.quantity : 1,
    buyerEmail: body.buyerEmail ?? null,
    shippingAddress: body.shippingAddress ?? null,
    selectedSize: stored.selectedSize,
    selectedVolume: stored.selectedVolume,
    selectedWeight: stored.selectedWeight,
    selectedBulkUnits: stored.selectedBulkUnits,
    discountCode:
      typeof body.discountCode === "string" ? body.discountCode : undefined,
    paymentMethod,
    mintUrl: body.mintUrl,
    cashuToken: body.cashuToken,
    fiatMethod: body.fiatMethod ?? stored.fiatMethod,
    subscriptionFrequency: stored.subscriptionFrequency,
    apiKeyId: apiKey.id,
    buyerPubkey: apiKey.pubkey,
  };

  const retriedMessage = makeMessage(
    "session_retried",
    `Retried with payment method "${paymentMethod}".`
  );

  // The engine call and the settlement write are SEPARATE try blocks on
  // purpose: once the engine returns (or throws past a payment side effect),
  // an order/payment may exist, and from that point the session must never be
  // restored to a retriable pre-order escalation — a later retry would place
  // a SECOND order (duplicate charge + inventory deduction).
  let result: OrderFlowResult;
  try {
    result = await createOrderFlow(input);
  } catch (error) {
    if (error instanceof OrderServiceError && error.body?.escalate) {
      // escalate is thrown ONLY by the pre-order sats-conversion guard
      // (resolveSatsAmount in order-service), provably before any order or
      // payment exists — the ONE failure class where restoring a retriable
      // escalation is safe. The session keeps the FRESH error/code so a later
      // read explains the latest attempt.
      const escalationError =
        typeof error.body.error === "string"
          ? error.body.error
          : "Checkout could not be completed automatically.";
      const escalationCode =
        typeof error.body.code === "string" ? error.body.code : null;
      const messages: CheckoutSessionMessage[] = [
        ...(claimed.messages || []),
        retriedMessage,
        makeMessage("requires_escalation", escalationError, "error"),
      ];
      const updated = await settleRetryEscalation(
        id,
        messages,
        escalationError,
        escalationCode,
        paymentMethod
      );
      return res
        .status(200)
        .json(formatCheckoutSession(updated || claimed, baseUrl));
    }
    // Ambiguous failure: validation errors are pre-order, but the engine also
    // throws AFTER createMcpOrder / payment side effects (e.g. invoice
    // verification, stock deduction, order email) and this route cannot tell
    // the two apart. Fail closed: leave the claim in place (status stays
    // 'incomplete', which retry refuses), record the attempt, and surface the
    // engine's exact answer. The agent checks its orders before paying again.
    const detail =
      error instanceof OrderServiceError &&
      typeof error.body?.error === "string"
        ? error.body.error
        : "Retry failed with an unexpected error.";
    if (!(error instanceof OrderServiceError)) {
      console.error("UCP checkout retry createOrderFlow error:", error);
    }
    const messages: CheckoutSessionMessage[] = [
      ...(claimed.messages || []),
      retriedMessage,
      makeMessage(
        "retry_failed",
        `${detail} The session was left non-retriable because an order may have been placed; check your orders before paying again.`,
        "error"
      ),
    ];
    await settleRetryAmbiguous(id, {
      mcpOrderId: null,
      paymentMethod,
      messages,
      error: claimed.error,
      code: claimed.code,
    });
    if (error instanceof OrderServiceError) {
      return res.status(error.status).json(error.body);
    }
    return res.status(500).json({ error: "Failed to retry checkout session" });
  }

  // The engine succeeded — an order/payment now exists (or a subscription).
  const described = describeResult(result);
  // One continued session: append the retry + the new opening state to the
  // existing timeline, not a second "session_created" entry.
  const messages: CheckoutSessionMessage[] = [
    ...(claimed.messages || []),
    retriedMessage,
    ...described.messages.filter((m) => m.type !== "session_created"),
  ];
  const quote = result.kind === "subscription" ? null : result.pricingBlock;

  let updated: CheckoutSessionRow | null = null;
  try {
    updated = await resolveCheckoutSessionRetry(id, {
      status: described.status,
      messages,
      payment: described.payment,
      quote,
      mcpOrderId: described.mcpOrderId,
      amountTotal: described.amountTotal,
      currency: described.currency,
      paymentMethod,
    });
  } catch (persistError) {
    console.error("UCP checkout retry resolve error:", persistError);
  }
  if (updated) {
    return res.status(200).json(formatCheckoutSession(updated, baseUrl));
  }

  // The order EXISTS but the session row could not be updated (DB error, or
  // the claim fence no longer matched after a concurrent status write).
  // NEVER restore a retriable escalation here: attach the order id and an
  // error marker with a status-preserving rescue write so the session stays
  // non-retriable and can reconcile on read, and still return the payment
  // descriptor so the buyer can complete payment.
  const rescued = await settleRetryAmbiguous(id, {
    mcpOrderId: described.mcpOrderId,
    payment: described.payment,
    quote,
    amountTotal: described.amountTotal,
    currency: described.currency,
    paymentMethod,
    messages,
    error:
      "Session record could not be updated after the order was placed; do not retry — reconcile via the order id.",
    code: "retry_settle_failed",
  });
  const fallbackRow: CheckoutSessionRow = rescued || {
    ...claimed,
    status: described.status,
    messages,
    payment: described.payment,
    quote,
    mcp_order_id: described.mcpOrderId,
    amount_total: String(described.amountTotal),
    currency: described.currency,
    payment_method: paymentMethod,
    error: null,
    code: null,
  };
  return res.status(200).json({
    ...formatCheckoutSession(fallbackRow, baseUrl),
    warning:
      "Session record could not be updated, but the order was placed — do not retry this session; reconcile via the order id.",
  });
}

/**
 * Return a claimed session to requires_escalation after a PROVABLY pre-order
 * failure (the escalate class only). A failure here must not mask the
 * engine's answer to the caller, so it logs loudly and returns null (the
 * session is left claimed-but-unsettled, i.e. status incomplete, which a
 * later read reports truthfully).
 */
async function settleRetryEscalation(
  id: string,
  messages: CheckoutSessionMessage[],
  error: string | null,
  code: string | null,
  paymentMethod: string
): Promise<CheckoutSessionRow | null> {
  try {
    return await failCheckoutSessionRetry(
      id,
      messages,
      error,
      code,
      paymentMethod
    );
  } catch (settleError) {
    console.error(
      "UCP checkout retry: failed to return session to requires_escalation:",
      settleError
    );
    return null;
  }
}

/**
 * Settle a claimed retry whose outcome is ambiguous or whose success write
 * failed, WITHOUT making the session retriable again (status-preserving
 * rescue write). A rescue failure logs loudly and returns null — the session
 * stays claimed ('incomplete'), which retry refuses, so no duplicate order
 * can come from this session either way.
 */
async function settleRetryAmbiguous(
  id: string,
  input: Parameters<typeof rescueCheckoutSessionRetry>[1]
): Promise<CheckoutSessionRow | null> {
  try {
    return await rescueCheckoutSessionRetry(id, input);
  } catch (settleError) {
    console.error(
      "UCP checkout retry: rescue write failed; session left claimed and non-retriable:",
      settleError
    );
    return null;
  }
}
