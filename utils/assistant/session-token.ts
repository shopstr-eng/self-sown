/**
 * Short-lived assistant chat session tokens.
 *
 * NIP-07 extensions and NIP-46 remote signers prompt (or round-trip) on EVERY
 * signature, so per-message NIP-98 auth makes the seller assistant painful for
 * exactly the users we never ask for a raw key. Instead the client signs ONE
 * NIP-98 request against /api/assistant/session and gets back a bearer token
 * good for `SESSION_TOKEN_TTL_MS`; subsequent chat messages authenticate with
 * the token and need no signer interaction.
 *
 * The token is stateless HMAC (same posture as the email unsubscribe tokens):
 *  - signed with SESSION_SECRET under a distinct label so an assistant token
 *    can never validate under another protocol (domain separation),
 *  - carries its own expiry, verified server-side on every chat request — no
 *    token outlives its window,
 *  - rotating SESSION_SECRET invalidates every outstanding token at once.
 *
 * Token format: `<base64url(JSON{pk, iat, exp})>.<mac32>`
 */
import { createHmac, timingSafeEqual } from "crypto";

export const SESSION_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes
// Clock-skew tolerance for the issued-at sanity check.
const FUTURE_SKEW_MS = 5 * 60 * 1000;

const HEX64 = /^[0-9a-f]{64}$/;

function getSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    throw new Error("SESSION_SECRET must be set to a string >= 16 chars");
  }
  return s;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(value: string): string {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

function macFor(payloadPart: string): string {
  return createHmac("sha256", getSecret())
    .update(`assistant-chat-session:${payloadPart}`)
    .digest("hex")
    .slice(0, 32);
}

export function mintAssistantSessionToken(
  pubkey: string,
  nowMs: number = Date.now()
): { token: string; expiresAtMs: number } {
  if (!HEX64.test(pubkey)) throw new Error("Invalid pubkey for session token");
  const expiresAtMs = nowMs + SESSION_TOKEN_TTL_MS;
  const payload = base64UrlEncode(
    JSON.stringify({ pk: pubkey, iat: nowMs, exp: expiresAtMs })
  );
  return { token: `${payload}.${macFor(payload)}`, expiresAtMs };
}

export function verifyAssistantSessionToken(
  token: string,
  nowMs: number = Date.now()
): { pubkey: string; expiresAtMs: number } | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadPart, macPart] = parts as [string, string];

  let expected: string;
  try {
    expected = macFor(payloadPart);
  } catch {
    return null; // secret not configured — sessions unavailable, never forged
  }
  if (macPart.length !== expected.length) return null;
  const a = new Uint8Array(Buffer.from(macPart, "utf8"));
  const b = new Uint8Array(Buffer.from(expected, "utf8"));
  if (!timingSafeEqual(a, b)) return null;

  let parsed: { pk?: unknown; iat?: unknown; exp?: unknown };
  try {
    parsed = JSON.parse(base64UrlDecode(payloadPart));
  } catch {
    return null;
  }
  const pubkey = typeof parsed.pk === "string" ? parsed.pk : "";
  const issuedAtMs = typeof parsed.iat === "number" ? parsed.iat : NaN;
  const expiresAtMs = typeof parsed.exp === "number" ? parsed.exp : NaN;
  if (!HEX64.test(pubkey)) return null;
  if (!Number.isInteger(issuedAtMs) || issuedAtMs <= 0) return null;
  if (!Number.isInteger(expiresAtMs) || expiresAtMs <= issuedAtMs) return null;
  // Reject tokens issued in the future, past their stated expiry, or with a
  // window longer than the TTL (a tampered payload would fail the MAC anyway;
  // these are belt-and-suspenders checks on the plaintext fields).
  if (issuedAtMs > nowMs + FUTURE_SKEW_MS) return null;
  if (expiresAtMs - issuedAtMs > SESSION_TOKEN_TTL_MS) return null;
  if (nowMs >= expiresAtMs) return null;
  return { pubkey, expiresAtMs };
}
