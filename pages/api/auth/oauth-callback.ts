import { NextApiRequest, NextApiResponse } from "next";
import { Client } from "pg";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import CryptoJS from "crypto-js";
import crypto from "crypto";
import { OAUTH_AUTH_SALT, LEGACY_OAUTH_AUTH_SALT } from "@/utils/auth/salts";

// Apple issues no static client secret: it is a short-lived ES256 JWT minted
// from the Sign in with Apple private key (.p8), team ID, and key ID.
// A pasted .p8 key arrives mangled in predictable ways: literal \n sequences,
// surrounding quotes, or one line with spaces where newlines were (single-line
// input fields collapse them). Normalize all of these to canonical PEM.
function normalizeApplePrivateKey(raw: string): string {
  let k = raw
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\\n/g, "\n");
  if (!k.includes("\n")) {
    const m = k.match(
      /-----BEGIN PRIVATE KEY-----\s*([\s\S]*?)\s*-----END PRIVATE KEY-----/
    );
    if (!m || !m[1]) return k; // unrecognized shape; let the signer report it
    const body = m[1].replace(/\s+/g, "");
    const wrapped = body.match(/.{1,64}/g)?.join("\n") ?? body;
    k = `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----\n`;
  }
  return k;
}

function buildAppleClientSecret(opts: {
  appleClientId: string;
  appleTeamId: string;
  appleKeyId: string;
  applePrivateKey: string;
}): string {
  const b64urlJson = (obj: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlJson({ alg: "ES256", kid: opts.appleKeyId, typ: "JWT" });
  const payload = b64urlJson({
    iss: opts.appleTeamId,
    iat: now,
    exp: now + 300, // short-lived per request; Apple allows up to ~6 months
    aud: "https://appleid.apple.com",
    sub: opts.appleClientId,
  });
  const unsigned = `${header}.${payload}`;
  const signature = crypto.sign("sha256", Buffer.from(unsigned), {
    key: normalizeApplePrivateKey(opts.applePrivateKey),
    dsaEncoding: "ieee-p1363", // JWS signature is raw r||s, not DER
  });
  return `${unsigned}.${signature.toString("base64url")}`;
}

// The success redirect carries credentials (nsec) in its query string, so its
// origin must be a verified initiating origin — never the configured site URL
// (a self-host instance with a stale NEXT_PUBLIC_BASE_URL would otherwise send
// credentials off-origin) and never a bare Host header. The authorize-time
// redirect_uri cookie is validated same-origin at oauth-redirect time, so its
// origin is trusted. When the cookie is absent (Apple's cross-site form_post
// omits Lax cookies), the browser provably reached us by POSTing to the
// provider-registered redirect URI, so the request host IS that registered
// origin.
function readCookie(req: NextApiRequest, name: string): string | undefined {
  const fromParser = req.cookies?.[name];
  if (fromParser) return fromParser;
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function getSuccessBaseUrl(req: NextApiRequest): string {
  const pinned = readCookie(req, "oauth_redirect_uri");
  if (pinned) {
    try {
      const u = new URL(pinned);
      const isLocal = u.hostname === "localhost" || u.hostname === "127.0.0.1";
      if (u.protocol === "https:" || (u.protocol === "http:" && isLocal)) {
        return u.origin;
      }
    } catch {
      // fall through to the request origin
    }
  }
  const protocol = req.headers["x-forwarded-proto"] || "https";
  return `${protocol}://${req.headers.host}`;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // Apple uses response_mode=form_post: its callback arrives as a POST with
  // form fields in the body; Google's arrives as a GET with query params.
  const code =
    req.method === "POST"
      ? (req.body?.code as string | undefined)
      : (req.query.code as string | undefined);
  const state =
    req.method === "POST"
      ? (req.body?.state as string | undefined)
      : (req.query.state as string | undefined);

  if (!code) {
    return res.status(400).send("Missing authorization code");
  }

  try {
    // Bind the callback to the browser that started the flow before any
    // token exchange, or an attacker can log a victim into the attacker's
    // account by replaying their own authorization response (login CSRF).
    // The state cookie is SameSite=None;Secure so it survives Apple's POST.
    const stateCookie = req.cookies["oauth_state"];
    if (!state || !stateCookie || state !== stateCookie) {
      throw new Error("OAuth state mismatch");
    }

    // Provider is pinned at redirect time via cookie (the callback URL is
    // shared, and neither query nor referer identifies the provider).
    const provider =
      req.cookies["oauth_provider"] ||
      (req.method === "POST" ? "apple" : "google");

    let email: string;
    let userId: string;
    let isNewUser = false; // Flag to indicate if the user is new
    let userData: any; // Declare userData at top level

    if (provider === "google") {
      // Get redirect URI from cookie to ensure it matches what was sent to Google
      const cookies =
        req.headers.cookie?.split(";").reduce(
          (acc, cookie) => {
            const [key, value] = cookie.trim().split("=");
            if (key && value) {
              acc[key] = value;
            }
            return acc;
          },
          {} as Record<string, string>
        ) || {};

      const redirectUri =
        cookies["oauth_redirect_uri"] ||
        `${req.headers["x-forwarded-proto"] || "https"}://${
          req.headers.host
        }/api/auth/oauth-callback`;

      // Exchange code for token
      const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: code as string,
          client_id: process.env["GOOGLE_CLIENT_ID"]!,
          client_secret: process.env["GOOGLE_CLIENT_SECRET"]!,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });

      const tokenData = await tokenResponse.json();

      if (!tokenResponse.ok || !tokenData.access_token) {
        throw new Error(`Token exchange failed: ${JSON.stringify(tokenData)}`);
      }

      // Get user info
      const userResponse = await fetch(
        "https://www.googleapis.com/oauth2/v2/userinfo",
        {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        }
      );

      userData = await userResponse.json();

      email = userData.email;
      userId = userData.id; // Google userinfo endpoint uses 'id' field for user ID

      if (!email || !userId) {
        throw new Error(
          `Missing user data from Google. Email: ${email}, UserId: ${userId}`
        );
      }
    } else if (provider === "apple") {
      const appleClientId = process.env["APPLE_CLIENT_ID"];
      const appleTeamId = process.env["APPLE_TEAM_ID"];
      const appleKeyId = process.env["APPLE_KEY_ID"];
      const applePrivateKey = process.env["APPLE_PRIVATE_KEY"];
      if (!appleClientId || !appleTeamId || !appleKeyId || !applePrivateKey) {
        throw new Error("Apple OAuth not configured");
      }

      // Must byte-match the redirect_uri sent to /auth/authorize.
      const redirectUri =
        req.cookies["oauth_redirect_uri"] ||
        `${req.headers["x-forwarded-proto"] || "https"}://${
          req.headers.host
        }/api/auth/oauth-callback`;

      const tokenResponse = await fetch(
        "https://appleid.apple.com/auth/token",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: appleClientId,
            client_secret: buildAppleClientSecret({
              appleClientId,
              appleTeamId,
              appleKeyId,
              applePrivateKey,
            }),
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
          }),
        }
      );

      const tokenData = await tokenResponse.json();
      if (!tokenResponse.ok || !tokenData.id_token) {
        throw new Error(`Token exchange failed: ${JSON.stringify(tokenData)}`);
      }

      // The id_token arrives from a server-to-server exchange authenticated by
      // our client secret (transport trust, same as Google's userinfo call);
      // still sanity-check the standard claims before using them.
      const claims = JSON.parse(
        Buffer.from(tokenData.id_token.split(".")[1], "base64").toString()
      );
      if (
        claims.iss !== "https://appleid.apple.com" ||
        claims.aud !== appleClientId ||
        typeof claims.exp !== "number" ||
        claims.exp * 1000 <= Date.now()
      ) {
        throw new Error("Apple id_token failed claim validation");
      }

      email = claims.email;
      userId = claims.sub;
      userData = { email };

      if (!email || !userId) {
        throw new Error(
          `Missing user data from Apple. Email: ${email}, UserId: ${userId}`
        );
      }
    } else {
      throw new Error(`Unsupported OAuth provider: ${provider}`);
    }

    if (!email || !userId) {
      throw new Error(
        `Missing user data after OAuth. Email: ${email}, UserId: ${userId}`
      );
    }

    // Store or retrieve Nostr keys for this OAuth account
    const client = new Client({
      connectionString: process.env["DATABASE_URL"],
    });

    await client.connect();

    // Check if user exists
    const existingUser = await client.query(
      "SELECT pubkey, encrypted_nsec FROM oauth_auth WHERE provider = $1 AND provider_user_id = $2",
      [provider, userId]
    );

    let nsec, pubkey;

    if (existingUser.rows.length > 0) {
      // Existing user - decrypt their nsec. The KDF salt rotated in the
      // Self-sown rebrand: try the new salt first, fall back to the legacy
      // salt, and on a legacy hit lazily re-encrypt the row under the new
      // salt (zero-downtime migration, no data loss).
      const deriveKey = (salt: string) =>
        CryptoJS.PBKDF2(`${provider}-${userId}`, salt, {
          keySize: 256 / 32,
          iterations: 1000,
        }).toString();
      const tryDecrypt = (salt: string): string => {
        try {
          const out = CryptoJS.AES.decrypt(
            existingUser.rows[0].encrypted_nsec,
            deriveKey(salt)
          ).toString(CryptoJS.enc.Utf8);
          return out.startsWith("nsec1") ? out : "";
        } catch {
          return "";
        }
      };

      nsec = tryDecrypt(OAUTH_AUTH_SALT);
      if (!nsec) {
        nsec = tryDecrypt(LEGACY_OAUTH_AUTH_SALT);
        if (nsec) {
          try {
            const rotated = CryptoJS.AES.encrypt(
              nsec,
              deriveKey(OAUTH_AUTH_SALT)
            ).toString();
            await client.query(
              "UPDATE oauth_auth SET encrypted_nsec = $1 WHERE provider = $2 AND provider_user_id = $3",
              [rotated, provider, userId]
            );
          } catch (rotateErr) {
            console.error("oauth-callback: salt rotation failed:", rotateErr);
          }
        }
      }
      pubkey = existingUser.rows[0].pubkey;
      isNewUser = false; // User exists, so not a new user
    } else {
      // New user - generate keys
      const secretKey = generateSecretKey();
      pubkey = getPublicKey(secretKey);
      nsec = nip19.nsecEncode(secretKey);

      const encryptionKey = CryptoJS.PBKDF2(
        `${provider}-${userId}`,
        OAUTH_AUTH_SALT,
        { keySize: 256 / 32, iterations: 1000 }
      ).toString();

      const encryptedNsec = CryptoJS.AES.encrypt(
        nsec,
        encryptionKey
      ).toString();

      if (!userId) {
        throw new Error("userId is null or undefined before database insert");
      }

      await client.query(
        "INSERT INTO oauth_auth (provider, provider_user_id, email, pubkey, encrypted_nsec) VALUES ($1, $2, $3, $4, $5)",
        [provider, userId, email, pubkey, encryptedNsec]
      );
      isNewUser = true; // User is new, set flag
    }

    await client.end();

    // Redirect to success page with nsec and pubkey
    const successUrl = new URL("/auth/oauth-success", getSuccessBaseUrl(req));
    successUrl.searchParams.set("nsec", nsec);
    successUrl.searchParams.set("pubkey", pubkey);
    successUrl.searchParams.set("provider", provider);
    successUrl.searchParams.set("isNewUser", isNewUser.toString());
    if (userData.email) {
      successUrl.searchParams.set("email", userData.email);
    }

    res.redirect(successUrl.toString());
  } catch (error) {
    console.error("OAuth callback error:", error);
    res.redirect(
      `/auth/oauth-error?error=${encodeURIComponent(String(error))}`
    );
  }
}
