import { NextApiRequest, NextApiResponse } from "next";

// Apple Pay domain verification. The domain-association file is NOT generated
// per merchant in the Dashboard — Stripe hosts ONE static file, identical for
// every merchant, at
//   https://stripe.com/files/apple-pay/apple-developer-merchantid-domain-association
// It must be served byte-exact at
// /.well-known/apple-developer-merchantid-domain-association
// (rewritten here in proxy.ts). The content is a public verification token,
// so it lives in a plain env var; 404 until it is set, which simply means
// Apple Pay stays unavailable on this domain (Google Pay is unaffected).
export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  const association = process.env["APPLE_PAY_DOMAIN_ASSOCIATION"];
  if (!association) {
    return res.status(404).end();
  }
  res.setHeader("Content-Type", "text/plain");
  res.setHeader("Cache-Control", "public, max-age=300");
  return res.status(200).send(association);
}
