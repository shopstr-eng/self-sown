import type { NextApiRequest, NextApiResponse } from "next";
import { verifySellerEmailUnsubscribeToken } from "@/utils/email/unsubscribe-tokens";
import { unsubscribeSellerEmail } from "@/utils/db/db-service";
import { applyRateLimit } from "@/utils/rate-limit";

// One-click unsubscribe for seller blog-broadcast emails.
//
// Supports both the human-clickable GET link and the RFC 8058 one-click POST
// (List-Unsubscribe-Post: List-Unsubscribe=One-Click). The signed token in the
// query string fully describes (sellerPubkey, email) so no other request input
// is trusted. On the POST path the body is `List-Unsubscribe=One-Click`, so the
// token is always read from the query, never the body.
const RATE_LIMIT = { limit: 60, windowMs: 60_000 };

function resultPage(title: string, message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${title}</title>
<style>
  body { margin:0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background:#f9fafb; color:#111827; }
  .card { max-width: 480px; margin: 64px auto; padding: 32px; background:#ffffff; border:1px solid #e5e7eb; border-radius:12px; text-align:center; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  p { font-size: 15px; line-height: 1.6; color:#374151; margin: 0; }
</style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await applyRateLimit(req, res, "email-unsubscribe", RATE_LIMIT)))
    return;

  const tokenRaw = req.query.token;
  const token = Array.isArray(tokenRaw) ? tokenRaw[0] : tokenRaw;
  const verified =
    typeof token === "string" ? verifySellerEmailUnsubscribeToken(token) : null;

  if (!verified) {
    if (req.method === "POST") {
      return res.status(400).json({ error: "Invalid or expired token" });
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res
      .status(400)
      .send(
        resultPage(
          "Link expired",
          "This unsubscribe link is invalid or has expired."
        )
      );
  }

  const ok = await unsubscribeSellerEmail(
    verified.sellerPubkey,
    verified.email
  );

  if (!ok) {
    if (req.method === "POST") {
      return res.status(500).json({ error: "Could not process unsubscribe" });
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res
      .status(500)
      .send(
        resultPage(
          "Something went wrong",
          "We couldn't process your request. Please try again later."
        )
      );
  }

  if (req.method === "POST") {
    return res.status(200).json({ unsubscribed: true });
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res
    .status(200)
    .send(
      resultPage(
        "You're unsubscribed",
        "You won't receive any more emails from this seller."
      )
    );
}
