import { NextApiRequest, NextApiResponse } from "next";
import { getDomainByHost } from "@/utils/db/custom-domains";
import { hasSquareConnection } from "@/utils/db/square-service";

// Apple Pay domain verification, host-aware. Each processor (Stripe, Square)
// has its OWN static association file — Stripe's is one file identical for
// every Stripe merchant
// (https://stripe.com/files/apple-pay/apple-developer-merchantid-domain-association),
// Square's is its own signed document — and Apple only ever fetches
//   /.well-known/apple-developer-merchantid-domain-association
// (rewritten here in proxy.ts), so a domain can verify with exactly ONE
// processor. Routing:
//   - platform marketplace host: 404. Apple Pay is intentionally disabled on
//     the general marketplace (product decision); utils/stripe/apple-pay.ts
//     likewise never registers the platform host.
//   - verified seller custom domain: serve the file matching the seller's
//     connected card processor (Square connection wins; seller card
//     processors are mutually exclusive).
//   - any other host (self-host instance, not-yet-verified domain): legacy
//     behavior — Stripe's file, or Square's for Square-only deployments.
// The contents are public verification tokens, so they live in plain env
// vars; a missing file for the resolved processor 404s, which simply means
// Apple Pay stays unavailable on that domain (Google Pay is unaffected).
function sendFile(res: NextApiResponse, body: string) {
  res.setHeader("Content-Type", "text/plain");
  res.setHeader("Cache-Control", "public, max-age=300");
  return res.status(200).send(body);
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const host = (req.headers.host || "").split(":")[0]?.toLowerCase() ?? "";
  const stripeFile = process.env["APPLE_PAY_DOMAIN_ASSOCIATION"];
  const squareFile = process.env["SQUARE_APPLE_PAY_DOMAIN_ASSOCIATION"];

  let platformHost = "";
  try {
    platformHost =
      new URL(process.env["NEXT_PUBLIC_BASE_URL"] || "").host
        .split(":")[0]
        ?.toLowerCase() ?? "";
  } catch {
    // Misconfigured base URL: treat every host as non-platform.
  }

  if (!host || (platformHost && host === platformHost)) {
    return res.status(404).end();
  }

  let body: string | undefined;
  try {
    const domain = await getDomainByHost(host);
    if (domain?.verified) {
      body = (await hasSquareConnection(domain.pubkey))
        ? squareFile
        : stripeFile;
    } else {
      body = stripeFile ?? squareFile;
    }
  } catch (error) {
    // DB outage: fall back to the legacy file rather than breaking every
    // custom domain's Apple Pay for the duration of the blip.
    console.error("Apple Pay association: domain lookup failed:", error);
    body = stripeFile;
  }

  if (!body) return res.status(404).end();
  return sendFile(res, body);
}
