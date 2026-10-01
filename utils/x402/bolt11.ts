// BOLT11 decoding for the x402 lnbtc scheme.
//
// Wraps the `bolt11` package's decoder and normalizes the fields the x402
// facilitator checks: currency, exact millisatoshi amount, payment hash,
// description hash, expiry, and the invoice signing key. `bolt11.decode`
// recovers the signing pubkey from the invoice signature (and cross-checks
// it against the optional `n` payee-node-key tag), so `payeeNodeKey` is
// always the key that actually signed the invoice — exactly what the spec
// requires `payTo` to equal.

import { decode } from "bolt11";

export interface X402Bolt11Invoice {
  /** BOLT11 currency code from the HRP, e.g. "bc" (mainnet) or "tb". */
  currency: string;
  /** Exact invoice amount in millisatoshis; null for amountless invoices. */
  amountMsat: bigint | null;
  /** Unix seconds creation time. */
  timestamp: number;
  /** Expiry in seconds after timestamp (BOLT11 default 3600). */
  expirySeconds: number;
  /** Lowercase hex payment hash (tag `p`). */
  paymentHash: string;
  /** Human-readable description (tag `d`), when present. */
  description?: string;
  /** Lowercase hex description hash (tag `h`), when present. */
  descriptionHash?: string;
  /** Compressed secp256k1 pubkey that signed the invoice (recovered). */
  payeeNodeKey: string;
}

export class Bolt11DecodeError extends Error {}

export function decodeBolt11(invoice: string): X402Bolt11Invoice {
  if (typeof invoice !== "string" || !/^ln[a-z0-9]+$/i.test(invoice)) {
    throw new Bolt11DecodeError("Not a BOLT11 invoice string");
  }
  let decoded: ReturnType<typeof decode>;
  try {
    // decode() verifies the bech32 checksum AND the invoice signature; it
    // throws on either failing, so a returned object is a well-formed,
    // authentically-signed invoice.
    decoded = decode(invoice.toLowerCase());
  } catch (error) {
    throw new Bolt11DecodeError(
      `Invalid BOLT11 invoice: ${
        error instanceof Error ? error.message : "unknown error"
      }`
    );
  }

  // HRP is "ln" + currency + optional amount, e.g. "lnbc250n".
  const prefix = decoded.prefix ?? "";
  const hrpMatch = prefix.match(/^ln([a-z]+?)([0-9].*)?$/);
  const currency = hrpMatch?.[1];
  if (!currency) {
    throw new Bolt11DecodeError(`Unrecognized invoice HRP: ${prefix}`);
  }

  const tags = decoded.tagsObject ?? {};
  const paymentHash = tags.payment_hash;
  if (!paymentHash || !/^[0-9a-f]{64}$/i.test(paymentHash)) {
    throw new Bolt11DecodeError("Invoice is missing a payment hash");
  }
  if (
    !decoded.payeeNodeKey ||
    !/^0[23][0-9a-f]{64}$/.test(decoded.payeeNodeKey)
  ) {
    throw new Bolt11DecodeError(
      "Invoice signing key could not be recovered from the signature"
    );
  }

  const msatRaw = decoded.millisatoshis;
  const amountMsat =
    msatRaw !== undefined && msatRaw !== null ? BigInt(msatRaw) : null;

  return {
    currency,
    amountMsat,
    timestamp: decoded.timestamp ?? 0,
    expirySeconds: tags.expire_time ?? 3600,
    paymentHash: paymentHash.toLowerCase(),
    ...(tags.description ? { description: tags.description } : {}),
    ...(tags.purpose_commit_hash
      ? { descriptionHash: String(tags.purpose_commit_hash).toLowerCase() }
      : {}),
    payeeNodeKey: decoded.payeeNodeKey,
  };
}
