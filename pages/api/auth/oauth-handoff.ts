import type { NextApiRequest, NextApiResponse } from "next";
import { applyRateLimit } from "@/utils/rate-limit";
import { consumeOAuthHandoff, OAUTH_HANDOFF_COOKIE } from "@/utils/auth/oauth-handoff";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  // A cross-origin page cannot send this non-simple header without CORS approval.
  // This endpoint deliberately has no CORS response headers.
  if (req.headers["x-oauth-handoff"] !== "1" ||
      (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin")) {
    return res.status(403).json({ error: "Same-origin request required" });
  }
  if (req.headers.origin) {
    try {
      if (new URL(req.headers.origin).host !== req.headers.host) {
        return res.status(403).json({ error: "Same-origin request required" });
      }
    } catch {
      return res.status(403).json({ error: "Same-origin request required" });
    }
  }
  if (!(await applyRateLimit(req, res, "oauth-handoff", { limit: 15, windowMs: 60_000 }))) return;
  const token = req.cookies[OAUTH_HANDOFF_COOKIE];
  res.setHeader("Set-Cookie", `${OAUTH_HANDOFF_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
  if (!token) return res.status(401).json({ error: "Sign-in expired. Please sign in again." });
  try {
    const payload = await consumeOAuthHandoff(token);
    if (!payload) return res.status(401).json({ error: "Sign-in expired. Please sign in again." });
    return res.status(200).json(payload);
  } catch {
    console.error("OAuth handoff failed");
    return res.status(500).json({ error: "Could not finish sign-in. Please sign in again." });
  }
}
