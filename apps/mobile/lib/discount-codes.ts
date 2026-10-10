import { signEventTemplate } from "@self-sown/nostr";
import type { SellerSession } from "@self-sown/domain";

import { getApiBaseUrl } from "@/lib/api-base-url";

// Mirrors the web discount-code contract in utils/nostr/request-auth.ts and
// pages/api/db/discount-codes.ts: every call carries a kind-27235 signed
// proof in the x-signed-event header whose tags bind action/method/path/
// pubkey plus the behavior-changing fields (sorted, String()-serialized,
// undefined/null/"" dropped).
const SIGNED_EVENT_HEADER = "x-signed-event";
const SIGNED_HTTP_REQUEST_KIND = 27235;
const DISCOUNT_CODES_PATH = "/api/db/discount-codes";

export type ShippingDiscountType = "none" | "free" | "percent" | "fixed";

export interface SellerDiscountCode {
  code: string;
  discount_percentage: number;
  expiration: number | null;
  max_uses: number | null;
  times_used: number;
  shipping_discount_type: ShippingDiscountType;
  shipping_discount_value: number;
}

export interface DiscountCodeDraft {
  code: string;
  discountPercentage: number;
  expiration?: number;
  maxUses?: number;
  shippingDiscountType: ShippingDiscountType;
  shippingDiscountValue: number;
}

type ProofValue = string | number | null | undefined;

function buildProofTags(
  action: string,
  method: "GET" | "POST" | "DELETE",
  pubkey: string,
  fields: Record<string, ProofValue> = {}
): string[][] {
  const sortedFields = Object.entries(fields)
    .flatMap(([key, value]) => {
      if (value === undefined || value === null || value === "") return [];
      return [[key, String(value)]] as Array<[string, string]>;
    })
    .sort(([left], [right]) => left.localeCompare(right));

  return [
    ["action", action],
    ["method", method],
    ["path", DISCOUNT_CODES_PATH],
    ["pubkey", pubkey],
    ...sortedFields,
  ];
}

function signProof(
  session: SellerSession,
  action: string,
  method: "GET" | "POST" | "DELETE",
  fields: Record<string, ProofValue> = {}
): string {
  const signedEvent = signEventTemplate(session, {
    kind: SIGNED_HTTP_REQUEST_KIND,
    created_at: Math.floor(Date.now() / 1000),
    content: "",
    tags: buildProofTags(action, method, session.pubkey, fields),
  });
  return JSON.stringify(signedEvent);
}

async function readErrorMessage(response: Response, fallback: string) {
  try {
    const body = (await response.json()) as {
      error?: string;
      message?: string;
    };
    return body.error ?? body.message ?? fallback;
  } catch {
    return fallback;
  }
}

export async function listDiscountCodes(
  session: SellerSession
): Promise<SellerDiscountCode[]> {
  const response = await fetch(
    `${getApiBaseUrl()}${DISCOUNT_CODES_PATH}?pubkey=${session.pubkey}`,
    {
      headers: {
        [SIGNED_EVENT_HEADER]: signProof(session, "list_discount_codes", "GET"),
      },
    }
  );
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, "Discount codes could not be loaded.")
    );
  }
  return (await response.json()) as SellerDiscountCode[];
}

export async function createDiscountCode(
  session: SellerSession,
  draft: DiscountCodeDraft
): Promise<void> {
  const response = await fetch(`${getApiBaseUrl()}${DISCOUNT_CODES_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Optional shipping fields stay out of the proof when unset, matching
      // the web client so legacy product-only codes keep verifying.
      [SIGNED_EVENT_HEADER]: signProof(
        session,
        "create_discount_code",
        "POST",
        {
          code: draft.code,
          discountPercentage: draft.discountPercentage,
          expiration: draft.expiration,
          shippingDiscountType:
            draft.shippingDiscountType === "none"
              ? undefined
              : draft.shippingDiscountType,
          shippingDiscountValue:
            draft.shippingDiscountType === "percent" ||
            draft.shippingDiscountType === "fixed"
              ? draft.shippingDiscountValue
              : undefined,
        }
      ),
    },
    body: JSON.stringify({
      code: draft.code,
      pubkey: session.pubkey,
      discountPercentage: draft.discountPercentage,
      expiration: draft.expiration,
      maxUses: draft.maxUses,
      shippingDiscountType: draft.shippingDiscountType,
      shippingDiscountValue: draft.shippingDiscountValue,
    }),
  });
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, "The discount code could not be added.")
    );
  }
}

export async function deleteDiscountCode(
  session: SellerSession,
  code: string
): Promise<void> {
  const response = await fetch(`${getApiBaseUrl()}${DISCOUNT_CODES_PATH}`, {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      [SIGNED_EVENT_HEADER]: signProof(
        session,
        "delete_discount_code",
        "DELETE",
        { code }
      ),
    },
    body: JSON.stringify({ code, pubkey: session.pubkey }),
  });
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(
        response,
        "The discount code could not be deleted."
      )
    );
  }
}

export function describeShippingDiscount(
  type: ShippingDiscountType,
  value: number
): string | null {
  if (type === "free") return "Free shipping";
  if (type === "percent" && value > 0) return `${value}% off shipping`;
  if (type === "fixed" && value > 0)
    return `${value} off shipping (in buyer's cart currency)`;
  return null;
}
