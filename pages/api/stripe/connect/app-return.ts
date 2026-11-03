import type { NextApiRequest, NextApiResponse } from "next";

import { isCustomAppSchemeUrl } from "@/utils/stripe/app-return-url";

// Stripe hosted flows (Connect account links) only accept http(s) return and
// refresh URLs, so mobile deep-link targets reach Stripe as this https bounce;
// it 302s into the app scheme, which the in-app auth session intercepts. The
// target must be a custom app scheme — those can only deep-link into an app on
// the device's owner, never load a web page (same policy as the allowlist in
// utils/site-url.ts), so scheme-level validation keeps this from becoming an
// open web redirector.
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const to = typeof req.query.to === "string" ? req.query.to : "";
  if (!to || !isCustomAppSchemeUrl(to)) {
    return res.status(400).json({ error: "Invalid return target" });
  }

  res.setHeader("Cache-Control", "private, no-store");
  return res.redirect(302, to);
}
