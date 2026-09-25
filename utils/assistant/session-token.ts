/**
 * Short-lived, scope-limited session tokens for assistant surfaces.
 *
 * NIP-07 extensions and NIP-46 remote signers prompt (or round-trip) on EVERY
 * signature, so per-request NIP-98 auth makes the seller assistant and the
 * signing-heavy settings screens painful for exactly the users we never ask
 * for a raw key. Instead the client signs ONE NIP-98 request against
 * /api/assistant/session and gets back a bearer token scoped to a single
 * surface; subsequent requests on that surface authenticate with the token
 * and need no signer interaction.
 *
 * Scopes are domain-separated: the scope is bound into both the signed
 * payload and the HMAC label, and verification requires the caller's expected
 * scope — a chat token never verifies on the setup or MCP-key endpoints and
 * vice versa.
 *
 * The token is stateless HMAC (same posture as the email unsubscribe tokens):
 *  - signed with SESSION_SECRET under a scope-specific label so a token can
 *    never validate under another protocol or scope (domain separation),
 *  - carries its own expiry, verified server-side on every request — no
 *    token outlives its window,
 *  - rotating SESSION_SECRET invalidates every outstanding token at once.
 *
 * Token format: `<base64url(JSON{pk, sc, iat, exp})>.<mac32>`
 */
import { createHmac, timingSafeEqual } from "crypto";

// The ONE set of session scopes. Every endpoint that accepts (or mints) a
// session token must take its scope from here — never an inline literal — so
// the scope an endpoint verifies against cannot silently drift from the scope
// the token was minted for.
export const SESSION_SCOPES = {
  chat: "chat",
  assistantSetup: "assistant-setup",
  mcpKeys: "mcp-keys",
} as const;

export type AssistantSessionScope =
  (typeof SESSION_SCOPES)[keyof typeof SESSION_SCOPES];

// Per-scope lifetimes. Chat tokens ride along a conversation; the management
// scopes authorize credential changes, so they live half as long.
export const SESSION_SCOPE_TTLS_MS: Record<AssistantSessionScope, number> = {
  chat: 30 * 60 * 1000,
  "assistant-setup": 15 * 60 * 1000,
  "mcp-keys": 15 * 60 * 1000,
};

// Backwards-compatible name for the chat scope's TTL.
export const SESSION_TOKEN_TTL_MS = SESSION_SCOPE_TTLS_MS.chat;

// Clock-skew tolerance for the issued-at sanity check.
const FUTURE_SKEW_MS = 5 * 60 * 1000;

const HEX64 = /^[0-9a-f]{64}$/;

export function isAssistantSessionScope(
  value: unknown
): value is AssistantSessionScope {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(SESSION_SCOPE_TTLS_MS, value)
  );
}

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

function macFor(scope: AssistantSessionScope, payloadPart: string): string {
  return createHmac("sha256", getSecret())
    .update(`assistant-session:${scope}:${payloadPart}`)
    .digest("hex")
    .slice(0, 32);
}

export function mintAssistantSessionToken(
  pubkey: string,
  scope: AssistantSessionScope = "chat",
  nowMs: number = Date.now()
): { token: string; expiresAtMs: number } {
  if (!HEX64.test(pubkey)) throw new Error("Invalid pubkey for session token");
  if (!isAssistantSessionScope(scope)) {
    throw new Error("Invalid scope for session token");
  }
  const expiresAtMs = nowMs + SESSION_SCOPE_TTLS_MS[scope];
  const payload = base64UrlEncode(
    JSON.stringify({ pk: pubkey, sc: scope, iat: nowMs, exp: expiresAtMs })
  );
  return { token: `${payload}.${macFor(scope, payload)}`, expiresAtMs };
}

export function verifyAssistantSessionToken(
  token: string,
  scope: AssistantSessionScope = "chat",
  nowMs: number = Date.now()
): { pubkey: string; expiresAtMs: number } | null {
  if (typeof token !== "string") return null;
  if (!isAssistantSessionScope(scope)) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadPart, macPart] = parts as [string, string];

  let expected: string;
  try {
    // The scope is part of the MAC label: a token minted for one scope can
    // never verify as another, even before the payload is inspected.
    expected = macFor(scope, payloadPart);
  } catch {
    return null; // secret not configured — sessions unavailable, never forged
  }
  if (macPart.length !== expected.length) return null;
  const a = new Uint8Array(Buffer.from(macPart, "utf8"));
  const b = new Uint8Array(Buffer.from(expected, "utf8"));
  if (!timingSafeEqual(a, b)) return null;

  let parsed: { pk?: unknown; sc?: unknown; iat?: unknown; exp?: unknown };
  try {
    parsed = JSON.parse(base64UrlDecode(payloadPart));
  } catch {
    return null;
  }
  const pubkey = typeof parsed.pk === "string" ? parsed.pk : "";
  const issuedAtMs = typeof parsed.iat === "number" ? parsed.iat : NaN;
  const expiresAtMs = typeof parsed.exp === "number" ? parsed.exp : NaN;
  // Belt-and-suspenders: the MAC already binds the scope, but the payload's
  // scope field must also match what the caller is verifying for.
  if (parsed.sc !== scope) return null;
  if (!HEX64.test(pubkey)) return null;
  if (!Number.isInteger(issuedAtMs) || issuedAtMs <= 0) return null;
  if (!Number.isInteger(expiresAtMs) || expiresAtMs <= issuedAtMs) return null;
  // Reject tokens issued in the future, past their stated expiry, or with a
  // window longer than the scope's TTL (a tampered payload would fail the MAC
  // anyway; these are belt-and-suspenders checks on the plaintext fields).
  if (issuedAtMs > nowMs + FUTURE_SKEW_MS) return null;
  if (expiresAtMs - issuedAtMs > SESSION_SCOPE_TTLS_MS[scope]) return null;
  if (nowMs >= expiresAtMs) return null;
  return { pubkey, expiresAtMs };
}
