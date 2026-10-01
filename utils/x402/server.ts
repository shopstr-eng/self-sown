// Server side of the x402 `exact`/`lnbtc` scheme: build the payment
// requirement for a challenge, and validate the payment payload a client
// submits on retry.
//
// We self-facilitate: Lightning needs no third-party settler, because the
// preimage IS the proof (SHA-256(preimage) == payment hash of an invoice we
// issued for the exact amount). Replay protection is the
// `x402_settled_payments` table (see utils/db/x402-service.ts).
//
// Documented deviation from the spec: the spec REQUIRES the invoice's BOLT11
// description-hash to equal the request hash. Invoices issued by the default
// Cashu mint authority cannot carry a caller-supplied description hash, so
// for mint-issued challenges `strictBinding` is false and the request is
// bound server-side instead (challenge ↔ order ↔ payment hash are persisted
// before the invoice is exposed, and settlement re-derives expectations from
// that row, never from client input). Sellers who configure their own LNbits
// invoice authority get fully spec-strict binding (`strictBinding: true`),
// because LNbits lets us set the description hash.

import { createHash } from "crypto";
import { decodeBolt11 } from "./bolt11";
import {
  X402_ASSET_BTC,
  X402_LNBTC_MAINNET,
  X402_PAYMENT_FLOW_UPFRONT,
  X402_SCHEME_EXACT,
  X402_TRANSFER_BOLT11,
} from "./constants";
import type {
  X402LnBtcExtra,
  X402PaymentPayload,
  X402PaymentRequirements,
  X402ResourceInfo,
} from "./types";

export interface X402RequestContext {
  requestHash: string;
  profile: "http:1" | "mcp:1";
  profileParams: Record<string, unknown>;
  resourceUrl: string;
  description: string;
}

/**
 * Build the PaymentRequirements for one challenge. Fails closed: if the
 * issued invoice doesn't match the requested amount or mainnet currency, or
 * its signing key can't be recovered, we throw instead of advertising a
 * requirement a payer couldn't trust.
 */
export function buildLnBtcRequirement(args: {
  amountSats: number;
  invoice: string;
  context: X402RequestContext;
  maxTimeoutSeconds: number;
}): X402PaymentRequirements {
  const decoded = decodeBolt11(args.invoice);
  const expectedMsat = BigInt(args.amountSats) * 1000n;
  if (decoded.amountMsat === null || decoded.amountMsat !== expectedMsat) {
    throw new Error(
      `Invoice amount ${decoded.amountMsat ?? "none"} does not match charge ${expectedMsat} msat`
    );
  }
  if (decoded.currency !== "bc") {
    throw new Error(`Invoice currency "${decoded.currency}" is not mainnet`);
  }
  const extra: X402LnBtcExtra = {
    assetTransferMethod: X402_TRANSFER_BOLT11,
    paymentFlow: X402_PAYMENT_FLOW_UPFRONT,
    invoice: args.invoice,
    requestHash: args.context.requestHash,
    requestBindingProfile: args.context.profile,
    requestBindingParams: args.context.profileParams,
  };
  return {
    scheme: X402_SCHEME_EXACT,
    network: X402_LNBTC_MAINNET,
    amount: expectedMsat.toString(),
    asset: X402_ASSET_BTC,
    payTo: decoded.payeeNodeKey,
    maxTimeoutSeconds: args.maxTimeoutSeconds,
    extra,
  };
}

export function buildPaymentRequired(args: {
  requirement: X402PaymentRequirements;
  context: X402RequestContext;
  error?: string;
}): {
  x402Version: 2;
  error?: string;
  resource: X402ResourceInfo;
  accepts: X402PaymentRequirements[];
} {
  return {
    x402Version: 2,
    ...(args.error ? { error: args.error } : {}),
    resource: {
      url: args.context.resourceUrl,
      description: args.context.description,
      mimeType: "application/json",
    },
    accepts: [args.requirement],
  };
}

export type X402Validation =
  | {
      ok: true;
      paymentHash: string;
      amountMsat: bigint;
      payeeNodeKey: string;
      invoice: string;
    }
  | { ok: false; reason: string };

/**
 * Validate a client's PAYMENT-SIGNATURE payload against what we expect for
 * the order being settled. Every expectation is derived server-side (from the
 * persisted challenge/order and the recomputed request hash) — never trusted
 * from the payload's echoed `accepted` fields alone.
 */
export function validatePaymentPayload(args: {
  payload: X402PaymentPayload;
  expectedAmountMsat: bigint;
  /** Recomputed from the request that will execute. */
  expectedRequestHash: string;
  /** True when the issuing authority embedded the hash in the invoice. */
  strictBinding: boolean;
  nowSeconds?: number;
}): X402Validation {
  const { payload } = args;
  const accepted = payload.accepted;

  if (accepted.scheme !== X402_SCHEME_EXACT) {
    return { ok: false, reason: "unsupported_scheme" };
  }
  if (accepted.network !== X402_LNBTC_MAINNET) {
    return { ok: false, reason: "unsupported_network" };
  }
  if (accepted.asset !== X402_ASSET_BTC) {
    return { ok: false, reason: "unsupported_asset" };
  }
  if (!/^[0-9]+$/.test(accepted.amount)) {
    return { ok: false, reason: "invalid_amount_format" };
  }
  const acceptedMsat = BigInt(accepted.amount);
  if (acceptedMsat !== args.expectedAmountMsat) {
    return { ok: false, reason: "amount_mismatch" };
  }

  const preimage = payload.payload?.preimage;
  if (typeof preimage !== "string" || !/^[0-9a-f]{64}$/.test(preimage)) {
    return { ok: false, reason: "invalid_preimage_format" };
  }

  const invoice = accepted.extra?.invoice;
  if (typeof invoice !== "string" || !invoice) {
    return { ok: false, reason: "missing_invoice" };
  }
  let decoded;
  try {
    decoded = decodeBolt11(invoice);
  } catch {
    return { ok: false, reason: "invalid_invoice" };
  }

  if (decoded.amountMsat === null || decoded.amountMsat !== acceptedMsat) {
    return { ok: false, reason: "invoice_amount_mismatch" };
  }
  if (decoded.currency !== "bc") {
    return { ok: false, reason: "invoice_currency_mismatch" };
  }
  // The spec: invoice signing key MUST equal payTo (the decode already
  // recovered it from the signature).
  if (decoded.payeeNodeKey !== accepted.payTo) {
    return { ok: false, reason: "payto_mismatch" };
  }
  if (decoded.expirySeconds !== accepted.maxTimeoutSeconds) {
    return { ok: false, reason: "expiry_mismatch" };
  }

  if (args.strictBinding) {
    if (!decoded.descriptionHash) {
      return { ok: false, reason: "invoice_missing_request_binding" };
    }
    if (decoded.descriptionHash !== args.expectedRequestHash.toLowerCase()) {
      return { ok: false, reason: "request_binding_mismatch" };
    }
  }

  // The cryptographic heart of the scheme: the preimage must hash to the
  // invoice's payment hash. This is what proves the payer actually paid.
  const preimageHash = createHash("sha256")
    .update(Buffer.from(preimage, "hex"))
    .digest("hex");
  if (preimageHash !== decoded.paymentHash) {
    return { ok: false, reason: "preimage_mismatch" };
  }

  return {
    ok: true,
    paymentHash: decoded.paymentHash,
    amountMsat: acceptedMsat,
    payeeNodeKey: decoded.payeeNodeKey,
    invoice,
  };
}
