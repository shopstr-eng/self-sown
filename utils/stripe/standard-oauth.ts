import crypto from "crypto";

/**
 * CSRF/binding state for the Standard Connect OAuth round-trip.
 *
 * The OAuth callback is an unauthenticated GET (the seller returns from
 * Stripe), so the only thing tying it back to the seller who started the flow
 * is this state token: an HMAC-signed { pubkey, exp, nonce, app?, ret? }
 * payload. The callback must verify the signature and expiry before exchanging
 * the code — otherwise anyone could link their Stripe account to a victim's
 * pubkey.
 *
 * `app` / `ret` select the post-OAuth landing spot. They only ever choose
 * between fixed, server-side redirect targets (web settings page, web
 * onboarding step, or the selfsown:// return deep link the in-app auth
 * session intercepts) — never a caller-supplied URL, so the flag can't turn
 * the callback into an open redirector.
 */

const STATE_TTL_MS = 15 * 60 * 1000; // 15 minutes to complete the OAuth flow

export type StandardOAuthReturn = "settings" | "onboarding";

interface OAuthStatePayload {
  pubkey: string;
  exp: number;
  nonce: string;
  app?: boolean;
  ret?: StandardOAuthReturn;
}

export interface VerifiedOAuthState {
  pubkey: string;
  app: boolean;
  ret: StandardOAuthReturn;
}

const getStateSecret = (): string => {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not configured");
  return secret;
};

const sign = (encoded: string): string =>
  crypto.createHmac("sha256", getStateSecret()).update(encoded).digest("hex");

export function createOAuthState(
  pubkey: string,
  opts?: { app?: boolean; ret?: StandardOAuthReturn }
): string {
  const payload: OAuthStatePayload = {
    pubkey,
    exp: Date.now() + STATE_TTL_MS,
    nonce: crypto.randomBytes(8).toString("hex"),
    ...(opts?.app ? { app: true } : {}),
    ...(opts?.ret && opts.ret !== "settings" ? { ret: opts.ret } : {}),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded)}`;
}

/**
 * Returns the verified payload when the state is authentic and unexpired,
 * else null. `app`/`ret` default to web-settings behavior for tokens minted
 * before the flags existed.
 */
export function verifyOAuthState(state: string): VerifiedOAuthState | null {
  if (typeof state !== "string") return null;
  const dot = state.lastIndexOf(".");
  if (dot <= 0) return null;
  const encoded = state.slice(0, dot);
  const signature = state.slice(dot + 1);
  const expected = sign(encoded);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString()
    ) as OAuthStatePayload;
    if (typeof payload.pubkey !== "string" || !payload.pubkey) return null;
    if (typeof payload.exp !== "number" || Date.now() > payload.exp)
      return null;
    return {
      pubkey: payload.pubkey,
      app: payload.app === true,
      ret: payload.ret === "onboarding" ? "onboarding" : "settings",
    };
  } catch {
    return null;
  }
}
