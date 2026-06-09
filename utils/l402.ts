// Minimal, facilitator-agnostic L402 helpers.
//
// L402 (https://docs.lightning.engineering/the-lightning-network/l402) is the
// "HTTP 402 Payment Required" standard for paying per-request with Lightning.
// The server answers a request for a paid resource with `402` and a
// `WWW-Authenticate: L402 macaroon="...", invoice="..."` challenge. The client
// pays the bolt11 invoice, obtains the preimage, and retries with
// `Authorization: L402 <macaroon>:<preimage>`.
//
// We are facilitator-agnostic: we do not depend on Aperture, Fewsats, or any
// specific gateway. The macaroon here is an opaque, signed-by-convention token
// that references the order so settlement can be confirmed through the existing
// mint-quote verification flow (see /api/mcp/verify-payment).

import type { NextApiResponse } from "next";
import { randomBytes } from "crypto";

export interface L402Challenge {
  macaroon: string;
  invoice: string;
}

/**
 * Build an opaque macaroon (base64) that binds the challenge to a specific
 * order + amount. It is NOT a security boundary on its own — settlement is
 * verified against the Lightning mint quote — but it lets a client correlate
 * the challenge it received with the order it is paying for.
 */
export function issueMacaroon(orderId: string, amountSats: number): string {
  const payload = {
    v: 1,
    oid: orderId,
    amt: amountSats,
    ts: Date.now(),
    nonce: randomBytes(8).toString("hex"),
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

/** Format the WWW-Authenticate challenge header value. */
export function buildL402Header(challenge: L402Challenge): string {
  return `L402 macaroon="${challenge.macaroon}", invoice="${challenge.invoice}"`;
}

/**
 * Set the standard L402 challenge headers on a 402 response. Also sets the
 * legacy `LSAT` alias some older clients expect (LSAT was L402's former name).
 */
export function setL402Challenge(
  res: NextApiResponse,
  challenge: L402Challenge
): void {
  const value = buildL402Header(challenge);
  res.setHeader("WWW-Authenticate", value);
}

/**
 * Build the `l402` block to embed in a 402 JSON body so non-header-aware
 * agents can still discover how to pay.
 */
export function buildL402Body(challenge: L402Challenge) {
  return {
    scheme: "L402",
    macaroon: challenge.macaroon,
    invoice: challenge.invoice,
    authorizationHeaderExample: `L402 ${challenge.macaroon}:<preimage>`,
    discovery: "https://milk.market/.well-known/l402.json",
    specification:
      "https://docs.lightning.engineering/the-lightning-network/l402",
  };
}
