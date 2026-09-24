import { NextApiRequest, NextApiResponse } from "next";
import { getDomainByHost } from "@/utils/db/custom-domains";
import { hasSquareConnection } from "@/utils/db/square-service";
import { isSelfHost } from "@/utils/self-host/config";

// Apple Pay domain verification file — Square-connected sellers ONLY.
//
// Stripe no longer uses a hosted association file: checkout domains are
// registered via the Payment Method Domain API and Stripe handles Apple's
// merchant validation behind the scenes (see utils/stripe/apple-pay.ts).
// Square still verifies a domain by fetching this exact well-known path, so
// the route serves Square's file only where Square Apple Pay can legitimately
// run:
//   - the platform host (Square Apple Pay runs on platform-host checkouts for
//     Square-connected sellers — one app-level domain activation; the button
//     only ever renders inside a Square seller's own checkout);
//   - self-host instance (SS_SELF_HOST env): the operator's own domain;
//   - verified seller custom domain whose seller is Square-connected
//     (seller card processors are mutually exclusive).
// Everything else 404s — including Stripe sellers' custom domains, which need
// no file at all. A DB outage 503s rather than risking a wrong response. The
// file contents are a public verification token, so the env var is plain (not
// secret). Google Pay is unaffected.
function sendFile(res: NextApiResponse, body: string) {
  res.setHeader("Content-Type", "text/plain");
  res.setHeader("Cache-Control", "public, max-age=300");
  return res.status(200).send(body);
}

// Port-, case-, and trailing-dot-insensitive host comparison.
function normalizeHost(host: string | undefined): string {
  return (host || "").split(":")[0]?.toLowerCase().replace(/\.$/, "") ?? "";
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const squareFile = process.env["SQUARE_APPLE_PAY_DOMAIN_ASSOCIATION"];
  if (!squareFile) return res.status(404).end();

  // Self-host: the instance's own domain is the seller's domain.
  if (isSelfHost()) return sendFile(res, squareFile);

  const host = normalizeHost(req.headers.host);
  let platformHost = "";
  try {
    platformHost = normalizeHost(
      new URL(process.env["NEXT_PUBLIC_BASE_URL"] || "").host
    );
  } catch {
    // Unparseable base URL: fail closed via the domain lookup below.
  }
  if (!host) return res.status(404).end();

  // Platform host: serve Square's file so Square Apple Pay can be activated
  // for platform-host checkouts (Square verifies the domain against OUR
  // platform application; per-seller exposure comes from the checkout only
  // rendering the button for Square-connected sellers).
  if (platformHost && host === platformHost) {
    return sendFile(res, squareFile);
  }

  try {
    const domain = await getDomainByHost(host);
    if (!domain?.verified) return res.status(404).end();
    if (!(await hasSquareConnection(domain.pubkey))) {
      // Stripe sellers need no hosted file — nothing to serve.
      return res.status(404).end();
    }
  } catch (error) {
    // DB outage: a transient fetch failure, never a wrong 200.
    console.error("Apple Pay association: domain lookup failed:", error);
    return res.status(503).end();
  }

  return sendFile(res, squareFile);
}
