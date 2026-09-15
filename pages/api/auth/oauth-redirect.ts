import { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const { provider, redirect_uri } = req.query;

  if (!provider || !redirect_uri) {
    return res.status(400).json({ error: "Missing provider or redirect_uri" });
  }
  if (provider !== "google" && provider !== "apple") {
    return res.status(400).json({ error: "Invalid provider" });
  }

  // Pin redirect_uri to this origin's callback endpoint: the value is stored
  // in a cookie, sent to the OAuth provider, and replayed at the callback for
  // the token-exchange byte-match, so it must never point off-site, and it
  // must not contain characters that could inject cookie attributes when it
  // lands in a Set-Cookie header.
  try {
    const u = new URL(redirect_uri as string);
    const isLocal = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (
      (u.protocol !== "https:" && !(u.protocol === "http:" && isLocal)) ||
      u.host !== req.headers.host ||
      u.pathname !== "/api/auth/oauth-callback" ||
      /[\s;]/.test(redirect_uri as string)
    ) {
      return res.status(400).json({ error: "Invalid redirect_uri" });
    }
  } catch {
    return res.status(400).json({ error: "Invalid redirect_uri" });
  }

  // Correlate the callback with the browser that started the flow
  // (login-CSRF protection). The state cookie must survive Apple's
  // cross-site form_post, hence SameSite=None + Secure; the app is always
  // served over HTTPS. Provider/redirect cookies stay Lax — Apple's POST
  // omits them and the callback deliberately falls back for those.
  const state = crypto.randomBytes(24).toString("base64url");
  res.setHeader("Set-Cookie", [
    `oauth_redirect=${redirect_uri}; Path=/; HttpOnly; SameSite=Lax`,
    `oauth_redirect_uri=${redirect_uri}; Path=/; HttpOnly; SameSite=Lax`,
    `oauth_provider=${provider}; Path=/; HttpOnly; SameSite=Lax`,
    `oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=None`,
  ]);

  if (provider === "google") {
    const googleClientId = process.env["GOOGLE_CLIENT_ID"];
    if (!googleClientId) {
      return res.status(500).json({ error: "Google OAuth not configured" });
    }

    // Use the redirect_uri exactly as passed from the client
    console.log("Google OAuth redirect_uri:", redirect_uri);

    const googleAuthUrl = new URL(
      "https://accounts.google.com/o/oauth2/v2/auth"
    );
    googleAuthUrl.searchParams.set("client_id", googleClientId);
    googleAuthUrl.searchParams.set("redirect_uri", redirect_uri as string);
    googleAuthUrl.searchParams.set("response_type", "code");
    googleAuthUrl.searchParams.set("scope", "openid email profile");
    googleAuthUrl.searchParams.set("access_type", "offline");
    googleAuthUrl.searchParams.set("prompt", "consent");
    googleAuthUrl.searchParams.set("state", state);

    return res.redirect(googleAuthUrl.toString());
  }

  if (provider === "apple") {
    const appleClientId = process.env["APPLE_CLIENT_ID"];
    if (!appleClientId) {
      return res.status(500).json({ error: "Apple OAuth not configured" });
    }

    const appleAuthUrl = new URL("https://appleid.apple.com/auth/authorize");
    appleAuthUrl.searchParams.set("client_id", appleClientId);
    appleAuthUrl.searchParams.set("redirect_uri", redirect_uri as string);
    appleAuthUrl.searchParams.set("response_type", "code");
    appleAuthUrl.searchParams.set("scope", "email name");
    appleAuthUrl.searchParams.set("response_mode", "form_post");
    appleAuthUrl.searchParams.set("state", state);

    return res.redirect(appleAuthUrl.toString());
  }
}
