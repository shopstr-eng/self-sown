// Square OAuth helpers (per-seller "connected accounts").
//
// Each seller connects their OWN Square account via OAuth. Square charges land
// directly on the seller's account (no platform split). UNLIKE Shippo's
// never-expiring tokens, Square access tokens EXPIRE (~30 days) and are renewed
// with a refresh token. Token storage + refresh-before-use lives in
// utils/db/square-service.ts and utils/square/square-api.ts.

import {
  getSquareApplicationId,
  getSquareConnectBaseUrl,
  getSquareApiVersion,
  getSquareRedirectUri,
  SQUARE_OAUTH_SCOPES,
} from "./square-config";

export function buildSquareAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: getSquareApplicationId(),
    scope: SQUARE_OAUTH_SCOPES.join(" "),
    session: "false",
    state,
    redirect_uri: getSquareRedirectUri(),
  });
  return `${getSquareConnectBaseUrl()}/oauth2/authorize?${params.toString()}`;
}

export interface SquareTokenResult {
  accessToken: string;
  // Square may omit the refresh token on a refresh response; callers must keep
  // the existing one when this is null.
  refreshToken: string | null;
  // RFC3339 timestamp string, e.g. "2026-08-01T00:00:00Z".
  expiresAt: string | null;
  merchantId: string | null;
}

interface SquareRawToken {
  access_token?: string;
  refresh_token?: string;
  expires_at?: string;
  merchant_id?: string;
  errors?: { detail?: string; code?: string }[];
  [k: string]: unknown;
}

async function postToken(
  body: Record<string, string>
): Promise<SquareTokenResult> {
  const clientId = getSquareApplicationId();
  const clientSecret = process.env.SQUARE_OAUTH_CLIENT_SECRET || "";
  if (!clientId || !clientSecret) {
    throw new Error("Square OAuth is not configured");
  }

  const res = await fetch(`${getSquareConnectBaseUrl()}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Square-Version": getSquareApiVersion(),
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      ...body,
    }),
  });

  const text = await res.text();
  let data: SquareRawToken | null = null;
  try {
    data = text ? (JSON.parse(text) as SquareRawToken) : null;
  } catch {
    data = null;
  }

  if (!res.ok || !data?.access_token) {
    const message =
      data?.errors?.[0]?.detail ||
      data?.errors?.[0]?.code ||
      `Square token request failed (${res.status})`;
    throw new Error(String(message));
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresAt: data.expires_at || null,
    merchantId: data.merchant_id || null,
  };
}

export async function exchangeSquareCodeForToken(
  code: string
): Promise<SquareTokenResult> {
  return postToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: getSquareRedirectUri(),
  });
}

export async function refreshSquareToken(
  refreshToken: string
): Promise<SquareTokenResult> {
  const result = await postToken({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  // Square does not always rotate/echo the refresh token on refresh; preserve
  // the existing one so we don't lose the ability to refresh again.
  if (!result.refreshToken) {
    result.refreshToken = refreshToken;
  }
  return result;
}

// Best-effort revocation at Square so the disconnected token can no longer be
// used. Local disconnect (deleting the row) must proceed regardless.
export async function revokeSquareToken(accessToken: string): Promise<void> {
  const clientId = getSquareApplicationId();
  const clientSecret = process.env.SQUARE_OAUTH_CLIENT_SECRET || "";
  if (!clientId || !clientSecret || !accessToken) return;
  try {
    await fetch(`${getSquareConnectBaseUrl()}/oauth2/revoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Square-Version": getSquareApiVersion(),
        Authorization: `Client ${clientSecret}`,
      },
      body: JSON.stringify({ client_id: clientId, access_token: accessToken }),
    });
  } catch (e) {
    console.warn("Square token revoke failed:", e);
  }
}
