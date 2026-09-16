import { NextApiRequest, NextApiResponse } from "next";
import { getDomainByHost } from "@/utils/db/custom-domains";
import { hasSquareConnection } from "@/utils/db/square-service";
import { isSelfHost } from "@/utils/self-host/config";

// Apple Pay domain verification, host-aware. Each processor (Stripe, Square)
// has its OWN static association file — Stripe's is one file identical for
// every Stripe merchant
// (https://stripe.com/files/apple-pay/apple-developer-merchantid-domain-association),
// Square's is its own signed document — and Apple only ever fetches
//   /.well-known/apple-developer-merchantid-domain-association
// (rewritten here in proxy.ts), so a domain can verify with exactly ONE
// processor. Routing:
//   - self-host instance: the instance IS the seller's domain, so serve
//     whatever the operator configured (Stripe file, or Square's for
//     Square-only deployments).
//   - platform marketplace host: 404. Apple Pay is intentionally disabled on
//     the general marketplace (product decision); utils/stripe/apple-pay.ts
//     likewise never registers the platform host.
//   - verified seller custom domain: serve the file matching the seller's
//     connected card processor (Square connection wins; seller card
//     processors are mutually exclusive). A missing file for the resolved
//     processor 404s, which simply means Apple Pay stays unavailable there.
//   - any other hosted host: 404 (fail closed — serving one processor's file
//     for the wrong domain can actively fail that domain's re-verification,
//     and an unparseable NEXT_PUBLIC_BASE_URL must never fail open onto the
//     marketplace).
//   - DB outage: 503 (a transient fetch failure), never a wrong-file 200.
// The contents are public verification tokens, so they live in plain env
// vars. Google Pay is unaffected by any of this.
function sendFile(res: NextApiResponse, body: string) {
  res.setHeader("Content-Type", "text/plain");
  res.setHeader("Cache-Control", "public, max-age=300");
  return res.status(200).send(body);
}

// Port-, case-, and trailing-dot-insensitive host comparison.
function normalizeHost(host: string | undefined): string {
  return (
    (host || "")
      .split(":")[0]
      ?.toLowerCase()
      .replace(/\.$/, "") ?? ""
  );
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const host = normalizeHost(req.headers.host);
  const stripeFile = process.env["APPLE_PAY_DOMAIN_ASSOCIATION"];
  const squareFile = process.env["SQUARE_APPLE_PAY_DOMAIN_ASSOCIATION"];

  // Self-host: the instance's own domain is the seller's domain; the operator
  // configures which processor's file to serve via env.
  if (isSelfHost()) {
    const body = stripeFile ?? squareFile;
    if (!body) return res.status(404).end();
    return sendFile(res, body);
  }

  let platformHost = "";
  try {
    platformHost = normalizeHost(
      new URL(process.env["NEXT_PUBLIC_BASE_URL"] || "").host
    );
  } catch {
    // Unparseable base URL: fail closed via the domain lookup below.
  }
  if (!host || (platformHost && host === platformHost)) {
    return res.status(404).end();
  }

  let body: string | undefined;
  try {
    const domain = await getDomainByHost(host);
    if (!domain?.verified) return res.status(404).end();
    body = (await hasSquareConnection(domain.pubkey))
      ? squareFile
      : stripeFile;
  } catch (error) {
    // DB outage: a transient fetch failure, never a wrong-file 200.
    console.error("Apple Pay association: domain lookup failed:", error);
    return res.status(503).end();
  }

  if (!body) return res.status(404).end();
  return sendFile(res, body);
}
