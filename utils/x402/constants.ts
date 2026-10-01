// x402 protocol constants for the Bitcoin Lightning (`lnbtc`) network
// implementation of the `exact` payment scheme.
//
// Spec: https://github.com/x402-foundation/x402 (specs/schemes/exact/
// scheme_exact_lnbtc.md). Only Bitcoin Lightning is supported — no other
// networks, chains, or tokens, per project policy.

export const X402_VERSION = 2;

export const X402_SCHEME_EXACT = "exact";

/** CAIP-2 identifier for Bitcoin Lightning mainnet (BIP-122 reference). */
export const X402_LNBTC_MAINNET = "lnbtc:000000000019d6689c085ae165831e93";

/** The only asset this server accepts or pays. */
export const X402_ASSET_BTC = "BTC";

/** The only asset transfer method for lnbtc. */
export const X402_TRANSFER_BOLT11 = "bolt11";

/** Lightning settles before the preimage exists, so `upfront` is the only
 * flow the lnbtc scheme supports. */
export const X402_PAYMENT_FLOW_UPFRONT = "upfront";

/** Request-binding profiles defined by the lnbtc scheme spec. */
export const X402_PROFILE_HTTP = "http:1";
export const X402_PROFILE_MCP = "mcp:1";

/** Domain-separation tag prefix: `"x402:exact:lnbtc:bolt11:" + profile`. */
export const X402_DOMAIN_PREFIX = "x402:exact:lnbtc:bolt11:";

/** HTTP headers used by x402 protocol version 2. */
export const X402_HEADERS = {
  paymentRequired: "payment-required",
  paymentSignature: "payment-signature",
  paymentResponse: "payment-response",
} as const;

/** Headers bound into the http:1 request hash for our REST resources: both
 * affect the purchased operation (account selection / body interpretation).
 * `payment-signature` itself MUST NOT be bound. */
export const X402_HTTP_BOUND_HEADERS = ["authorization", "content-type"];

/** Invoice expiry we request from spec-strict invoice authorities; the
 * BOLT11 expiry MUST equal maxTimeoutSeconds exactly, so this single value
 * is used for both. */
export const X402_INVOICE_EXPIRY_SECONDS = 3600;

/** Spend guardrail for the buyer-side pay tool: invoices above this many
 * sats are rejected unless the caller raises it explicitly. */
export const X402_DEFAULT_MAX_PAYMENT_SATS = 100_000;
export const X402_ABSOLUTE_MAX_PAYMENT_SATS = 1_000_000;
