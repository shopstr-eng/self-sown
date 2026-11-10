import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import type { Event } from "nostr-tools";

import {
  computePosCartTotals,
  pricePosCartLine,
  type PosCartLine,
  type PosPaymentMethod,
  type SellerSession,
} from "@self-sown/domain";
import {
  createNip98AuthorizationHeader,
  createSellerPosOrderGiftWrap,
  publishSellerOrderStatusGiftWrap,
} from "@self-sown/nostr";

import { getApiBaseUrl } from "@/lib/api-base-url";
import { mobileSellerOrdersApiClient } from "@/lib/api-client";

// Pubkey-scoped per the mobile storage rule. The stored gift wraps are signed
// ciphertext addressed to the seller — no credential material.
const PENDING_RECORDS_PREFIX = "self-sown:pos:pending-records";

function pendingKey(pubkey: string): string {
  return `${PENDING_RECORDS_PREFIX}:${pubkey}`;
}

export interface FinalizePosSaleInput {
  session: SellerSession;
  lines: PosCartLine[];
  method: PosPaymentMethod;
  /** Invoice hash/preimage, Stripe PaymentIntent id, Square payment id, "cash". */
  paymentReference: string;
  note?: string;
  buyerEmail?: string;
}

export interface FinalizePosSaleResult {
  saleId: string;
  orderIds: string[];
  /** Lines whose order event could not be published (queued for retry). */
  failedLines: number;
}

async function stashPendingRecord(pubkey: string, wrap: Event): Promise<void> {
  const key = pendingKey(pubkey);
  const raw = await AsyncStorage.getItem(key);
  let existing: Event[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) existing = parsed as Event[];
    } catch {
      existing = [];
    }
  }
  existing.push(wrap);
  await AsyncStorage.setItem(key, JSON.stringify(existing.slice(-50)));
}

/** Retry publishing sale records that failed earlier (called on PoS mount). */
export async function flushPendingPosRecords(
  session: SellerSession
): Promise<number> {
  const key = pendingKey(session.pubkey);
  const raw = await AsyncStorage.getItem(key);
  if (!raw) return 0;
  let wraps: Event[] = [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) wraps = parsed as Event[];
  } catch {
    wraps = [];
  }
  if (wraps.length === 0) {
    await AsyncStorage.removeItem(key);
    return 0;
  }
  const stillPending: Event[] = [];
  for (const wrap of wraps) {
    try {
      await publishSellerOrderStatusGiftWrap({
        baseUrl: getApiBaseUrl(),
        session,
        giftWrap: wrap,
      });
    } catch {
      stillPending.push(wrap);
    }
  }
  if (stillPending.length > 0) {
    await AsyncStorage.setItem(key, JSON.stringify(stillPending));
  } else {
    await AsyncStorage.removeItem(key);
  }
  return stillPending.length;
}

// Walk the seller-managed chain pending→confirmed→shipped→completed so a paid
// in-person sale lands as completed in the Orders tabs instead of sitting in
// the pending queue. Best-effort: the order record itself already published.
async function advanceOrderToCompleted(
  session: SellerSession,
  orderId: string
): Promise<void> {
  const baseUrl = getApiBaseUrl();
  const steps = [
    { status: "confirmed", expectedStatus: "pending" },
    { status: "shipped", expectedStatus: "confirmed" },
    { status: "completed", expectedStatus: "shipped" },
  ] as const;
  for (const step of steps) {
    const transitionId = `pos-${orderId}-${step.status}`;
    // The NIP-98 proof must bind the URL and body the api-client actually
    // sends (update-order-status), or the server rejects every transition.
    const body = JSON.stringify({
      orderId,
      sellerPubkey: session.pubkey,
      buyerPubkey: null,
      expectedStatus: step.expectedStatus,
      status: step.status,
      transitionId,
    });
    const authorizationHeader = createNip98AuthorizationHeader({
      session,
      url: `${baseUrl}/api/db/update-order-status`,
      method: "POST",
      body,
    });
    await mobileSellerOrdersApiClient.updateOrderStatus({
      orderId,
      sellerPubkey: session.pubkey,
      buyerPubkey: null,
      expectedStatus: step.expectedStatus,
      status: step.status,
      transitionId,
      authorizationHeader,
    });
  }
}

async function sendPosReceiptEmail(input: {
  saleId: string;
  session: SellerSession;
  lines: PosCartLine[];
  method: PosPaymentMethod;
  buyerEmail: string;
  note?: string;
}): Promise<void> {
  const totals = computePosCartTotals(input.lines);
  const productTitle =
    input.lines.length === 1
      ? input.lines[0]!.item.title
      : `In-person sale (${totals.itemCount} items)`;
  const body = JSON.stringify({
    orderId: input.saleId,
    sellerPubkey: input.session.pubkey,
    productTitle,
    amount: totals.total,
    currency: totals.currency,
    paymentMethod: input.method,
    buyerEmail: input.buyerEmail,
    quantity: totals.itemCount,
    ...(input.note ? { buyerContact: input.note } : {}),
  });
  const response = await fetch(
    `${getApiBaseUrl()}/api/email/send-order-email`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }
  );
  if (!response.ok) {
    throw new Error(`Receipt email failed (${response.status})`);
  }
}

/**
 * Record a paid PoS sale: one seller-authored gift-wrapped order event per
 * cart line (same kind:14 contract as online orders, so both Orders tabs pick
 * the sale up), then advance each to completed, then the optional receipt
 * email. Payment has already been collected by the caller — recording must
 * never silently lose a paid sale, so per-line publish failures are queued to
 * AsyncStorage and retried on the next PoS open.
 */
export async function finalizePosSale(
  input: FinalizePosSaleInput
): Promise<FinalizePosSaleResult> {
  const saleId = Crypto.randomUUID();
  const baseUrl = getApiBaseUrl();
  const orderIds: string[] = [];
  let failedLines = 0;

  for (const [index, line] of input.lines.entries()) {
    const orderId = `${saleId}-${index}`;
    const pricing = pricePosCartLine(line.item, line.quantity);

    let wrap: Event;
    try {
      wrap = createSellerPosOrderGiftWrap({
        session: input.session,
        orderId,
        line,
        pricing,
        paymentMethod: input.method,
        paymentReference: input.paymentReference,
        ...(input.buyerEmail ? { buyerEmail: input.buyerEmail } : {}),
        ...(input.note ? { note: input.note } : {}),
      });
    } catch {
      failedLines += 1;
      continue;
    }

    try {
      await publishSellerOrderStatusGiftWrap({
        baseUrl,
        session: input.session,
        giftWrap: wrap,
      });
      orderIds.push(orderId);
    } catch {
      failedLines += 1;
      await stashPendingRecord(input.session.pubkey, wrap).catch(() => {});
      orderIds.push(orderId);
    }
  }

  // Status advancement and the receipt email must never mask a recorded sale.
  for (const orderId of orderIds) {
    await advanceOrderToCompleted(input.session, orderId).catch(() => {});
  }
  if (input.buyerEmail) {
    await sendPosReceiptEmail({
      saleId,
      session: input.session,
      lines: input.lines,
      method: input.method,
      buyerEmail: input.buyerEmail,
      ...(input.note ? { note: input.note } : {}),
    }).catch(() => {});
  }

  return { saleId, orderIds, failedLines };
}
