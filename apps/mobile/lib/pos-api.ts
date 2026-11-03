import { createNip98AuthorizationHeader } from "@self-sown/nostr";
import type { SellerSession } from "@self-sown/domain";

import { getApiBaseUrl } from "@/lib/api-base-url";

// Server PoS routes attach a machine-readable `code` to error payloads (e.g.
// connection-token's 403 stripe_not_connected); keep it on the thrown error
// so callers can tell "connect Stripe first" apart from a transient failure.
export class PosApiError extends Error {
  code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "PosApiError";
    this.code = code;
  }
}

export function isStripeNotConnectedError(error: unknown): boolean {
  return error instanceof PosApiError && error.code === "stripe_not_connected";
}

// NIP-98-authenticated JSON POST for the PoS server routes. Mirrors how the
// orders runtime signs /api/db/* calls: full URL + method + payload hash.
async function posPost<T>(
  session: SellerSession,
  path: string,
  body: Record<string, unknown>
): Promise<T> {
  const url = `${getApiBaseUrl()}${path}`;
  const serialized = JSON.stringify(body);
  const authorizationHeader = createNip98AuthorizationHeader({
    session,
    url,
    method: "POST",
    body: serialized,
  });
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authorizationHeader,
    },
    body: serialized,
  });
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const body =
      payload && typeof payload === "object"
        ? (payload as { error?: unknown; code?: unknown })
        : null;
    const message = body?.error
      ? String(body.error)
      : `Request failed (${response.status})`;
    throw new PosApiError(
      message,
      typeof body?.code === "string" ? body.code : undefined
    );
  }
  return payload as T;
}

export type PosPaymentMethods = {
  stripe: { connected: boolean; chargesEnabled: boolean };
  square: { connected: boolean };
};

export function fetchPosPaymentMethods(
  session: SellerSession
): Promise<PosPaymentMethods> {
  return posPost<PosPaymentMethods>(session, "/api/pos/payment-methods", {});
}

export function createStripeTerminalConnectionToken(
  session: SellerSession
): Promise<{ secret: string }> {
  return posPost(session, "/api/stripe/terminal/connection-token", {});
}

export function createStripeTerminalPaymentIntent(
  session: SellerSession,
  input: {
    amountSmallest: number;
    currency: string;
    orderId: string;
    description?: string;
  }
): Promise<{ clientSecret: string; paymentIntentId: string }> {
  return posPost(session, "/api/stripe/terminal/create-payment-intent", {
    amountSmallest: input.amountSmallest,
    currency: input.currency,
    orderId: input.orderId,
    ...(input.description ? { description: input.description } : {}),
  });
}

export function createSquarePosPaymentLink(
  session: SellerSession,
  input: {
    amountSmallest: number;
    currency: string;
    orderId: string;
    title: string;
    note?: string;
  }
): Promise<{ url: string; linkId: string; orderId: string | null }> {
  return posPost(session, "/api/square/pos-link", {
    amountSmallest: input.amountSmallest,
    currency: input.currency,
    orderId: input.orderId,
    title: input.title,
    ...(input.note ? { note: input.note } : {}),
  });
}

export function fetchSquarePosLinkStatus(
  session: SellerSession,
  input: { linkId: string; orderId?: string | null }
): Promise<{ paid: boolean; paymentId?: string }> {
  return posPost(session, "/api/square/pos-link-status", {
    linkId: input.linkId,
    ...(input.orderId ? { orderId: input.orderId } : {}),
  });
}
