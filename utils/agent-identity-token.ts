import { createHmac, timingSafeEqual } from "crypto";

// Hand-rolled HS256 JWT for the agent-auth identity_assertion flow
// (pages/api/agent/identity.ts -> pages/api/oauth2/token.ts). The project
// carries no JWT library and these assertions are only ever minted and
// verified by this server, so a minimal HMAC-signed token over
// SESSION_SECRET is sufficient. Never accept tokens signed elsewhere.
//
// The assertion proves only "this server issued this short-lived token for
// this pubkey (or anonymous caller)" — exchanging it at /api/oauth2/token
// yields a real shopping-audience API key.

export interface IdentityAssertionPayload {
  // "anonymous" = no key ownership claimed; "service_auth" = caller proved
  // control of `sub` with a signed Nostr event at the identity endpoint.
  typ: "anonymous" | "service_auth";
  // Hex pubkey the resulting API key is bound to. For anonymous callers the
  // identity endpoint generates a fresh keypair and puts its pubkey here.
  sub: string;
  // Optional agent display name carried through to the API key record.
  name?: string;
  iat: number;
  exp: number;
}

const ASSERTION_TTL_SECONDS = 10 * 60;
const AUDIENCE = "self-sown:agent-auth";

function signingKey(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET is not configured");
  }
  return secret;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(data: string): string {
  return base64url(createHmac("sha256", signingKey()).update(data).digest());
}

export function mintIdentityAssertion(
  payload: Omit<IdentityAssertionPayload, "iat" | "exp">
): string {
  const now = Math.floor(Date.now() / 1000);
  const body: IdentityAssertionPayload = {
    ...payload,
    iat: now,
    exp: now + ASSERTION_TTL_SECONDS,
  };
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const encodedBody = base64url(JSON.stringify({ ...body, aud: AUDIENCE }));
  const unsigned = `${header}.${encodedBody}`;
  return `${unsigned}.${sign(unsigned)}`;
}

export function verifyIdentityAssertion(
  token: string
): IdentityAssertionPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;

  const expected = sign(`${header}.${body}`);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let parsed: IdentityAssertionPayload & { aud?: string };
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (parsed.aud !== AUDIENCE) return null;
  if (parsed.typ !== "anonymous" && parsed.typ !== "service_auth") return null;
  if (typeof parsed.sub !== "string" || !/^[0-9a-f]{64}$/i.test(parsed.sub))
    return null;
  if (
    typeof parsed.exp !== "number" ||
    parsed.exp < Math.floor(Date.now() / 1000)
  )
    return null;

  return parsed;
}
