/**
 * Signed "leave a review" deep-links for custom email flows.
 *
 * A seller can drop a {{review_link}} button into a flow email. At real-send
 * time we mint a per-recipient signed token that encodes which order (and, when
 * known, which product) the review is for, the seller, and — when the buyer
 * checked out with Nostr keys — the buyer pubkey. The link points at the
 * seller's orders dashboard (their verified custom domain when they have one,
 * otherwise milk.market). When the buyer opens it, the dashboard verifies the
 * token via `/api/email/flows/review-link`, finds the matching decrypted order,
 * and auto-opens the existing Nostr review modal.
 *
 * IMPORTANT: the token is a capability to PRE-FILL the review UI, not an
 * authorization to post a review. Posting still requires the buyer's own Nostr
 * signature; guests without keys are simply prompted to sign in. So the token
 * carries no privileges and only needs tamper-resistance, which the HMAC gives.
 *
 * Signing key + domain separation match the other flow trackers: a "review:"
 * MAC prefix means a review token can never be replayed as an open ("open:") or
 * click token, or vice-versa.
 */
import { createHmac, timingSafeEqual } from "crypto";
import { getDomainByPubkey } from "@/utils/db/custom-domains";

// Kept in lockstep with the click-tracking TTL in flow-link-tracking.ts: a
// {{review_link}} is always rewritten through the 90-day click redirect, so a
// longer review TTL here would be a dead promise — the tracked link stops
// resolving at 90 days regardless of what this token allows.
const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export interface ReviewLinkContext {
  orderId: string;
  productAddress?: string | null;
  sellerPubkey: string;
  buyerPubkey?: string | null;
}

export interface DecodedReviewLink {
  orderId: string;
  productAddress: string | null;
  sellerPubkey: string;
  buyerPubkey: string | null;
  issuedAtMs: number;
}

function getSecret(): string {
  const s =
    process.env.EMAIL_FLOW_CLICK_SECRET || process.env.FLOW_PROCESSOR_SECRET;
  if (!s || s.length < 16) {
    throw new Error(
      "EMAIL_FLOW_CLICK_SECRET (or FLOW_PROCESSOR_SECRET) must be set to a string >= 16 chars to sign review links"
    );
  }
  return s;
}

function b64urlEncode(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function b64urlDecode(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}

// "review:" domain separation — a review token is never interchangeable with an
// open ("open:") or click token.
function macFor(payloadB64: string): string {
  return createHmac("sha256", getSecret())
    .update(`review:${payloadB64}`)
    .digest("base64url");
}

const HEX64 = /^[0-9a-f]{64}$/i;

/**
 * Mint a signed token for a review deep-link. Short keys keep the URL compact.
 * Optional fields (product address, buyer pubkey) are omitted when absent.
 */
export function mintReviewLinkToken(
  ctx: ReviewLinkContext,
  nowMs: number = Date.now()
): string {
  const payload: Record<string, unknown> = {
    o: ctx.orderId,
    s: ctx.sellerPubkey,
    t: nowMs,
  };
  if (ctx.productAddress) payload.a = ctx.productAddress;
  if (ctx.buyerPubkey) payload.b = ctx.buyerPubkey;
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  return `${payloadB64}.${macFor(payloadB64)}`;
}

/**
 * Verify a token and return the decoded review context, or null if the token is
 * missing/tampered/expired.
 */
export function verifyReviewLinkToken(
  token: string,
  nowMs: number = Date.now()
): DecodedReviewLink | null {
  if (typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot >= token.length - 1) return null;
  const payloadB64 = token.slice(0, dot);
  const macPart = token.slice(dot + 1);

  let expected: string;
  try {
    expected = macFor(payloadB64);
  } catch {
    return null;
  }
  if (macPart.length !== expected.length) return null;
  const a = new Uint8Array(Buffer.from(macPart, "utf8"));
  const b = new Uint8Array(Buffer.from(expected, "utf8"));
  if (!timingSafeEqual(a, b)) return null;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64));
  } catch {
    return null;
  }

  const issuedAtMs = Number(payload.t);
  if (!Number.isInteger(issuedAtMs) || issuedAtMs <= 0) return null;
  if (issuedAtMs > nowMs + 5 * 60 * 1000) return null;
  if (nowMs - issuedAtMs > TOKEN_TTL_MS) return null;

  const orderId = typeof payload.o === "string" ? payload.o : "";
  if (!orderId || orderId.length > 200) return null;

  const sellerPubkey =
    typeof payload.s === "string" && HEX64.test(payload.s) ? payload.s : "";
  if (!sellerPubkey) return null;

  const productAddress =
    typeof payload.a === "string" &&
    payload.a.includes(":") &&
    payload.a.length <= 300
      ? payload.a
      : null;

  const buyerPubkey =
    typeof payload.b === "string" && HEX64.test(payload.b) ? payload.b : null;

  return {
    orderId,
    productAddress,
    sellerPubkey,
    buyerPubkey,
    issuedAtMs,
  };
}

/**
 * Where a seller's buyers should land to manage their orders: the seller's
 * verified, TLS-active custom domain when they have one, else milk.market. We
 * require the domain to be both verified and TLS attached/active so we never
 * send a buyer to a half-provisioned domain that won't load over https.
 */
export async function resolveReviewOrdersUrl(
  sellerPubkey: string,
  baseUrl: string
): Promise<string> {
  const fallback = `${baseUrl.replace(/\/+$/, "")}/orders`;
  try {
    const domain = await getDomainByPubkey(sellerPubkey);
    if (
      domain &&
      domain.verified &&
      (domain.tls_status === "attached" || domain.tls_status === "active")
    ) {
      return `https://${domain.domain}/orders`;
    }
  } catch {
    // fall through to the platform URL
  }
  return fallback;
}
