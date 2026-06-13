/**
 * Open tracking for custom email flows.
 *
 * At real-send time we append a tiny hidden 1x1 image ("tracking pixel") to the
 * rendered flow email. When the recipient's mail client loads that image it hits
 * `/api/email/flows/open` carrying a signed token. The endpoint verifies the
 * signature, records an open, then returns a transparent GIF.
 *
 * Opens are inherently approximate: many mail clients (Apple Mail Privacy
 * Protection, Gmail image proxy, corporate scanners) pre-fetch or block images,
 * so opens can be inflated or hidden. We surface them to sellers as estimates;
 * clicks and orders are the reliable signals.
 *
 * The signing key matches the click tracker: `EMAIL_FLOW_CLICK_SECRET` if set,
 * otherwise `FLOW_PROCESSOR_SECRET`. The MAC is domain-separated with an
 * "open:" prefix so an open token and a click token are never interchangeable.
 */
import { createHmac, timingSafeEqual } from "crypto";

const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export interface FlowOpenContext {
  flowId: number;
  stepId: number;
  enrollmentId: number;
  executionId?: number | null;
  sellerPubkey: string;
}

export interface DecodedFlowOpen {
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
      "EMAIL_FLOW_CLICK_SECRET (or FLOW_PROCESSOR_SECRET) must be set to a string >= 16 chars to sign flow open pixels"
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

// Domain-separated from the click tracker ("open:" prefix) so a click token can
// never be replayed as an open token, and vice versa.
function macFor(payloadB64: string): string {
  return createHmac("sha256", getSecret())
    .update(`open:${payloadB64}`)
    .digest("base64url");
}

/**
 * Mint a signed token for an open pixel. Short keys keep the URL compact.
 */
export function mintFlowOpenToken(
  ctx: FlowOpenContext,
  nowMs: number = Date.now()
): string {
  const payload = {
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
 * Verify a token and return the decoded open context, or null if the token is
 * missing/tampered/expired.
 */
export function verifyFlowOpenToken(
  token: string,
  nowMs: number = Date.now()
): DecodedFlowOpen | null {
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
    flowId,
    stepId,
    enrollmentId,
    executionId,
    sellerPubkey,
    issuedAtMs,
  };
}

/**
 * Build the hidden tracking-pixel `<img>` tag, or "" if no signing secret is
 * configured (in which case open tracking is simply disabled).
 */
export function buildOpenPixelTag(
  baseUrl: string,
  ctx: FlowOpenContext
): string {
  let token: string;
  try {
    token = mintFlowOpenToken(ctx);
  } catch {
    return "";
  }
  const base = baseUrl.replace(/\/+$/, "");
  const url = `${base}/api/email/flows/open?t=${encodeURIComponent(token)}`;
  return `<img src="${url}" width="1" height="1" alt="" style="display:none;width:1px;height:1px;border:0;overflow:hidden" />`;
}

/**
 * Append the tracking pixel to a rendered flow email (just before `</body>` if
 * present, otherwise at the end). Returns the html unchanged when tracking is
 * disabled. Call this AFTER link rewriting.
 */
export function appendOpenPixel(
  html: string,
  baseUrl: string,
  ctx: FlowOpenContext
): string {
  const pixel = buildOpenPixelTag(baseUrl, ctx);
  if (!pixel) return html;
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${pixel}</body>`);
  }
  return html + pixel;
}
