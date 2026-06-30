// Square environment + URL configuration.
//
// A single `SQUARE_ENVIRONMENT` setting drives BOTH the server-side Connect API
// base URL and the client Web Payments SDK script URL, so sandbox testing and
// production share exactly one code path. The Square application id doubles as
// the OAuth client id AND the public Web Payments SDK application id — it is not
// a secret and is safe to send to the browser. The OAuth client secret and the
// per-seller access/refresh tokens never leave the server.

export type SquareEnvironment = "sandbox" | "production";

export function getSquareEnvironment(): SquareEnvironment {
  const v = (process.env.SQUARE_ENVIRONMENT || "").trim().toLowerCase();
  return v === "production" ? "production" : "sandbox";
}

// The Square application id == the OAuth client id == the public Web Payments
// SDK application id. Public, not a secret.
export function getSquareApplicationId(): string {
  return process.env.SQUARE_OAUTH_CLIENT_ID || "";
}

export function isSquareConfigured(): boolean {
  // Require an explicit, valid SQUARE_ENVIRONMENT in addition to the OAuth
  // credentials. Otherwise a production deploy that sets only the id/secret
  // would silently fall back to sandbox (see getSquareEnvironment) and expose
  // Square in sandbox mode instead of failing closed.
  const env = (process.env.SQUARE_ENVIRONMENT || "").trim().toLowerCase();
  return !!(
    process.env.SQUARE_OAUTH_CLIENT_ID &&
    process.env.SQUARE_OAUTH_CLIENT_SECRET &&
    (env === "sandbox" || env === "production")
  );
}

// Connect API base (server-side REST calls: oauth, locations, payments, catalog).
export function getSquareConnectBaseUrl(): string {
  return getSquareEnvironment() === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";
}

// Web Payments SDK script URL (client-side card form).
export function getSquareWebSdkUrl(env?: SquareEnvironment): string {
  const e = env || getSquareEnvironment();
  return e === "production"
    ? "https://web.squarecdn.com/v1/square.js"
    : "https://sandbox.web.squarecdn.com/v1/square.js";
}

// Square requires a dated API version header on every Connect call. Pinned, but
// overridable via env so it can be bumped without a code change if Square
// retires the version.
export function getSquareApiVersion(): string {
  return process.env.SQUARE_API_VERSION || "2025-01-23";
}

function getBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_BASE_URL ||
    (process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : "http://localhost:3000")
  );
}

// Must EXACTLY match the redirect URI registered with the Square application.
export function getSquareRedirectUri(): string {
  return `${getBaseUrl().replace(/\/+$/, "")}/square-oauth-redirect`;
}

// Scopes: charge cards on the seller's account (PAYMENTS_WRITE/READ), read their
// locations + merchant profile (for the location id + currency), and read their
// catalog for the product import.
export const SQUARE_OAUTH_SCOPES = [
  "PAYMENTS_WRITE",
  "PAYMENTS_READ",
  "MERCHANT_PROFILE_READ",
  "ITEMS_READ",
];
