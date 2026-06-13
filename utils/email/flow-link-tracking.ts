/**
 * Trackable links for custom email flows.
 *
 * Sellers author CTA buttons/links in their flow steps (see
 * `flow-step-editor.tsx`). At real-send time we rewrite each http(s) link in the
 * rendered email to point at our own redirect endpoint
 * (`/api/email/flows/click`) carrying a signed token. The endpoint verifies the
 * signature, records a click, then 302s to the original destination.
 *
 * Security: the destination URL is *inside* the signed token, so the redirect
 * target can't be tampered with — there is no open-redirect surface. We never
 * redirect to a query-supplied URL, only to one we signed. Tokens also carry an
 * issued-at timestamp and expire, and only http/https destinations are allowed.
 *
 * The signing key is `EMAIL_FLOW_CLICK_SECRET` if set (so operators can rotate
 * it independently), otherwise it falls back to `FLOW_PROCESSOR_SECRET`, which
 * is already required for any flow email to be sent at all.
 */
import { createHmac, timingSafeEqual } from "crypto";

const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const MAX_DEST_LEN = 2048;

export interface FlowLinkContext {
  destinationUrl: string;
  flowId: number;
  stepId: number;
  enrollmentId: number;
  executionId?: number | null;
  sellerPubkey: string;
}

export interface DecodedFlowLink {
  destinationUrl: string;
  flowId: number;
  stepId: number;
  enrollmentId: number;
  executionId: number | null;
  sellerPubkey: string;
  issuedAtMs: number;
}

function getSecret(): string {
  const s =
    process.env.EMAIL_FLOW_CLICK_SECRET || process.env.FLOW_PROCESSOR_SECRET;
  if (!s || s.length < 16) {
    throw new Error(
      "EMAIL_FLOW_CLICK_SECRET (or FLOW_PROCESSOR_SECRET) must be set to a string >= 16 chars to sign flow click links"
    );
  }
  return s;
}

export function isTrackableHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function b64urlEncode(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function b64urlDecode(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}

function macFor(payloadB64: string): string {
  return createHmac("sha256", getSecret())
    .update(payloadB64)
    .digest("base64url");
}

/**
 * Mint a signed token for a single tracked link. The payload uses short keys to
 * keep the resulting URL compact for email clients.
 */
export function mintFlowLinkToken(
  ctx: FlowLinkContext,
  nowMs: number = Date.now()
): string {
  const payload = {
    u: ctx.destinationUrl,
    f: ctx.flowId,
    s: ctx.stepId,
    e: ctx.enrollmentId,
    x: ctx.executionId ?? null,
    p: ctx.sellerPubkey,
    t: nowMs,
  };
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  return `${payloadB64}.${macFor(payloadB64)}`;
}

/**
 * Verify a token and return the decoded link context, or null if the token is
 * missing/tampered/expired or carries a non-http(s) destination.
 */
export function verifyFlowLinkToken(
  token: string,
  nowMs: number = Date.now()
): DecodedFlowLink | null {
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
  // Reject future-dated tokens (5 min clock-skew tolerance) and expired ones.
  if (issuedAtMs > nowMs + 5 * 60 * 1000) return null;
  if (nowMs - issuedAtMs > TOKEN_TTL_MS) return null;

  const destinationUrl = typeof payload.u === "string" ? payload.u : "";
  if (
    !destinationUrl ||
    destinationUrl.length > MAX_DEST_LEN ||
    !isTrackableHttpUrl(destinationUrl)
  ) {
    return null;
  }

  const flowId = Number(payload.f);
  const stepId = Number(payload.s);
  const enrollmentId = Number(payload.e);
  if (
    ![flowId, stepId, enrollmentId].every((n) => Number.isInteger(n) && n > 0)
  ) {
    return null;
  }

  const executionId = payload.x == null ? null : Number(payload.x);
  if (
    executionId !== null &&
    (!Number.isInteger(executionId) || executionId <= 0)
  ) {
    return null;
  }

  const sellerPubkey =
    typeof payload.p === "string" && /^[0-9a-f]{64}$/i.test(payload.p)
      ? payload.p
      : "";
  if (!sellerPubkey) return null;

  return {
    destinationUrl,
    flowId,
    stepId,
    enrollmentId,
    executionId,
    sellerPubkey,
    issuedAtMs,
  };
}

// Matches the href value of an <a> tag (double-quoted, as emitted by the editor
// and the default templates).
const HREF_RE = /(<a\b[^>]*?\shref=")([^"]*)(")/gi;

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

export interface RewriteContext {
  baseUrl: string;
  flowId: number;
  stepId: number;
  enrollmentId: number;
  executionId?: number | null;
  sellerPubkey: string;
}

/**
 * Rewrite every http(s) link in a rendered flow email so clicks route through
 * the tracking redirect. Non-http links (mailto:, tel:, #anchors), our own
 * click endpoint, and over-long URLs are left untouched. Call this AFTER
 * merge-tag substitution and storefront button coloring.
 */
export function rewriteFlowEmailLinks(
  html: string,
  ctx: RewriteContext
): string {
  const base = ctx.baseUrl.replace(/\/+$/, "");
  return html.replace(HREF_RE, (match, pre, rawHref, post) => {
    const decoded = decodeHtmlEntities(String(rawHref)).trim();
    if (!isTrackableHttpUrl(decoded)) return match;
    if (decoded.length > MAX_DEST_LEN) return match;
    // Never double-wrap a link that already points at our click endpoint.
    if (decoded.includes("/api/email/flows/click")) return match;

    let token: string;
    try {
      token = mintFlowLinkToken({
        destinationUrl: decoded,
        flowId: ctx.flowId,
        stepId: ctx.stepId,
        enrollmentId: ctx.enrollmentId,
        executionId: ctx.executionId ?? null,
        sellerPubkey: ctx.sellerPubkey,
      });
    } catch {
      // No signing secret configured — leave the original link intact.
      return match;
    }

    const trackingUrl = `${base}/api/email/flows/click?t=${encodeURIComponent(
      token
    )}`;
    return `${pre}${escapeHtmlAttr(trackingUrl)}${post}`;
  });
}
