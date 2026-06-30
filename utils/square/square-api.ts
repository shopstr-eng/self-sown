// Server-side Square Connect API calls (locations, payments) plus the
// refresh-before-use token resolver. All seller-scoped calls go through
// getValidSquareAccessToken so an expiring token is renewed transparently.

import {
  getSquareConnection,
  updateSquareTokens,
} from "@/utils/db/square-service";
import { refreshSquareToken } from "./square-oauth";
import { getSquareConnectBaseUrl, getSquareApiVersion } from "./square-config";
import type {
  SquareCatalogItem,
  SquareCatalogVariation,
} from "@/utils/migrations/square-to-nip99";

// Refresh proactively when fewer than this many ms remain before expiry, so a
// renewal failure still leaves a wide window where the current token works.
const REFRESH_BUFFER_MS = 7 * 24 * 60 * 60 * 1000;

export interface ValidSquareAccess {
  accessToken: string;
  locationId: string | null;
  locationCurrency: string | null;
  merchantId: string | null;
}

// Resolve a usable access token for a seller, refreshing first if it is within
// the expiry buffer. Returns null if the seller has no connected Square account.
//
// Concurrency note: two requests can race into a refresh. That is harmless —
// Square keeps the prior access token valid until its original expiry even after
// issuing a new one, so both racers end up with a working token and the last
// write wins. No cross-instance lock is required.
export async function getValidSquareAccessToken(
  pubkey: string
): Promise<ValidSquareAccess | null> {
  const conn = await getSquareConnection(pubkey);
  if (!conn || conn.status !== "connected") return null;

  let accessToken = conn.accessToken;
  const expiresMs = conn.expiresAt ? new Date(conn.expiresAt).getTime() : 0;
  const expiringSoon = !expiresMs || expiresMs - Date.now() < REFRESH_BUFFER_MS;

  if (conn.refreshToken && expiringSoon) {
    try {
      const refreshed = await refreshSquareToken(conn.refreshToken);
      accessToken = refreshed.accessToken;
      await updateSquareTokens(pubkey, {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: refreshed.expiresAt,
      });
    } catch (e) {
      // If the current token is still valid, keep using it; only fail hard when
      // it has already expired and we could not renew.
      if (expiresMs && expiresMs > Date.now()) {
        console.warn("Square token refresh failed; using current token:", e);
      } else {
        throw new Error("Square access token expired and refresh failed");
      }
    }
  }

  return {
    accessToken,
    locationId: conn.locationId,
    locationCurrency: conn.locationCurrency,
    merchantId: conn.merchantId,
  };
}

interface SquareApiErrorBody {
  errors?: { detail?: string; code?: string; category?: string }[];
}

async function squareFetch<T>(
  accessToken: string,
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(`${getSquareConnectBaseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Square-Version": getSquareApiVersion(),
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = (data as SquareApiErrorBody)?.errors?.[0];
    throw new Error(
      err?.detail || err?.code || `Square API error (${res.status})`
    );
  }
  return data as T;
}

export interface SquareLocation {
  id: string;
  name: string | null;
  currency: string | null;
  status: string | null;
}

export async function fetchSquareLocations(
  accessToken: string
): Promise<SquareLocation[]> {
  const data = await squareFetch<{
    locations?: {
      id: string;
      name?: string;
      currency?: string;
      status?: string;
    }[];
  }>(accessToken, "/v2/locations");
  return (data.locations || []).map((l) => ({
    id: l.id,
    name: l.name ?? null,
    currency: l.currency ?? null,
    status: l.status ?? null,
  }));
}

// Pick the seller's primary location: prefer an ACTIVE one, else the first.
export function pickPrimaryLocation(
  locations: SquareLocation[]
): SquareLocation | null {
  if (!locations.length) return null;
  return locations.find((l) => l.status === "ACTIVE") || locations[0] || null;
}

export interface CreateSquarePaymentInput {
  // Card nonce produced client-side by the Web Payments SDK card.tokenize().
  sourceId: string;
  // Stable per-checkout-attempt key so a retry can't double-charge.
  idempotencyKey: string;
  // Integer amount in the smallest currency unit (cents for USD, whole for JPY).
  amount: number;
  // ISO 4217, must match the seller's Square location currency.
  currency: string;
  locationId: string;
  note?: string;
  buyerEmailAddress?: string;
  referenceId?: string;
}

export interface SquarePaymentResult {
  id: string;
  status: string;
}

export async function createSquarePayment(
  accessToken: string,
  input: CreateSquarePaymentInput
): Promise<SquarePaymentResult> {
  const body: Record<string, unknown> = {
    source_id: input.sourceId,
    idempotency_key: input.idempotencyKey,
    amount_money: { amount: input.amount, currency: input.currency },
    location_id: input.locationId,
    autocomplete: true,
  };
  if (input.note) body.note = input.note.slice(0, 500);
  if (input.buyerEmailAddress) {
    body.buyer_email_address = input.buyerEmailAddress.slice(0, 255);
  }
  if (input.referenceId) body.reference_id = input.referenceId.slice(0, 40);

  const data = await squareFetch<{
    payment?: { id: string; status: string };
  }>(accessToken, "/v2/payments", {
    method: "POST",
    body: JSON.stringify(body),
  });

  const payment = data.payment;
  if (!payment?.id) throw new Error("Square payment did not return an id");
  return { id: payment.id, status: payment.status };
}

// Re-fetch a payment to re-verify it server-side. Retrieving with the SELLER's
// own access token is what binds the payment to that seller: a payment id from a
// different Square account returns 404 here. Returns null when the payment can't
// be retrieved (unknown id / not on this account) so callers can fail closed.
export async function getSquarePayment(
  accessToken: string,
  paymentId: string
): Promise<SquarePaymentResult | null> {
  try {
    const data = await squareFetch<{
      payment?: { id: string; status: string };
    }>(accessToken, `/v2/payments/${encodeURIComponent(paymentId)}`);
    const payment = data.payment;
    if (!payment?.id) return null;
    return { id: payment.id, status: payment.status };
  } catch {
    return null;
  }
}

// ---- Catalog (product import) ----

interface SquareCatalogObject {
  type?: string;
  id: string;
  is_deleted?: boolean;
  item_data?: {
    name?: string;
    description?: string;
    is_archived?: boolean;
    image_ids?: string[];
    variations?: {
      id: string;
      item_variation_data?: {
        name?: string;
        sku?: string;
        price_money?: { amount?: number; currency?: string };
      };
    }[];
  };
  image_data?: { url?: string };
}

// Fetch the seller's catalog as ITEM objects with their variations + resolved
// image URLs. Items carry their variations inline; IMAGE objects are separate,
// so we collect both types and map image ids to urls. Deleted objects are
// skipped. Paginates until Square stops returning a cursor, bounded by a page
// cap and an item cap so a huge catalog can't exhaust memory.
export async function fetchSquareCatalog(
  accessToken: string,
  maxItems = 500
): Promise<SquareCatalogItem[]> {
  const imageUrlById = new Map<string, string>();
  const rawItems: SquareCatalogObject[] = [];
  let cursor: string | undefined;
  let pages = 0;

  do {
    const params = new URLSearchParams({ types: "ITEM,IMAGE" });
    if (cursor) params.set("cursor", cursor);
    const data = await squareFetch<{
      objects?: SquareCatalogObject[];
      cursor?: string;
    }>(accessToken, `/v2/catalog/list?${params.toString()}`);

    for (const obj of data.objects || []) {
      if (obj.is_deleted) continue;
      if (obj.type === "IMAGE" && obj.image_data?.url) {
        imageUrlById.set(obj.id, obj.image_data.url);
      } else if (obj.type === "ITEM" && obj.item_data) {
        rawItems.push(obj);
      }
    }

    cursor = data.cursor;
    pages += 1;
  } while (cursor && pages < 20);

  return rawItems.slice(0, maxItems).map((obj) => {
    const d = obj.item_data!;
    const variations: SquareCatalogVariation[] = (d.variations || []).map(
      (v) => {
        const vd = v.item_variation_data || {};
        const amount = vd.price_money?.amount;
        return {
          id: v.id,
          name: vd.name ?? null,
          priceAmount: typeof amount === "number" ? amount : null,
          priceCurrency: vd.price_money?.currency ?? null,
          sku: vd.sku ?? null,
        };
      }
    );
    const imageUrls = (d.image_ids || [])
      .map((id) => imageUrlById.get(id))
      .filter((u): u is string => !!u);
    return {
      id: obj.id,
      name: d.name ?? null,
      description: d.description ?? null,
      imageUrls,
      variations,
      isArchived: !!d.is_archived,
    };
  });
}
