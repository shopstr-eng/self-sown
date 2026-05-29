// Shippo OAuth ("standalone accounts" / gray-label) helpers.
//
// In this model each seller connects their OWN Shippo account via OAuth. Shippo
// bills the seller directly; the platform never holds a Shippo balance. Access
// tokens are prefixed `oauth.` and NEVER expire, so there is no refresh flow.
//
// Credentials (client id/secret) are obtained manually from Shippo
// (partnerships@goshippo.com) with the registered callback path
// `/shippo-oauth-redirect`.

const SHIPPO_AUTHORIZE_URL = "https://goshippo.com/oauth/authorize";
const SHIPPO_TOKEN_URL = "https://goshippo.com/oauth/access_token";

// Full access. Shippo grants the same scopes the partner app is approved for.
const SHIPPO_OAUTH_SCOPE = "*";

export function isShippoOAuthConfigured(): boolean {
  return !!(
    process.env.SHIPPO_OAUTH_CLIENT_ID && process.env.SHIPPO_OAUTH_CLIENT_SECRET
  );
}

function getBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_BASE_URL ||
    (process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : "http://localhost:3000")
  );
}

// Must EXACTLY match the redirect URI registered with Shippo for the app.
export function getShippoRedirectUri(): string {
  return `${getBaseUrl().replace(/\/+$/, "")}/shippo-oauth-redirect`;
}

export function buildShippoAuthorizeUrl(state: string): string {
  const clientId = process.env.SHIPPO_OAUTH_CLIENT_ID || "";
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: SHIPPO_OAUTH_SCOPE,
    state,
    redirect_uri: getShippoRedirectUri(),
  });
  return `${SHIPPO_AUTHORIZE_URL}?${params.toString()}`;
}

export interface ShippoTokenResponse {
  accessToken: string;
  scope: string | null;
  accountId: string | null;
}

interface ShippoRawTokenResponse {
  access_token?: string;
  scope?: string;
  account_id?: string;
  account?: { object_id?: string } | string;
  [key: string]: unknown;
}

export async function exchangeShippoCodeForToken(
  code: string
): Promise<ShippoTokenResponse> {
  const clientId = process.env.SHIPPO_OAUTH_CLIENT_ID || "";
  const clientSecret = process.env.SHIPPO_OAUTH_CLIENT_SECRET || "";
  if (!clientId || !clientSecret) {
    throw new Error("Shippo OAuth is not configured");
  }

  const res = await fetch(SHIPPO_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: getShippoRedirectUri(),
    }),
  });

  const text = await res.text();
  let data: ShippoRawTokenResponse | null = null;
  try {
    data = text ? (JSON.parse(text) as ShippoRawTokenResponse) : null;
  } catch {
    data = null;
  }

  if (!res.ok || !data?.access_token) {
    const message =
      (data && (data.error_description || data.error)) ||
      text ||
      `Shippo token exchange failed (${res.status})`;
    throw new Error(String(message));
  }

  const accountId =
    data.account_id ||
    (typeof data.account === "string"
      ? data.account
      : data.account?.object_id) ||
    null;

  return {
    accessToken: data.access_token,
    scope: data.scope || SHIPPO_OAUTH_SCOPE,
    accountId,
  };
}
