// Invoice authorities for x402 (and the shared MCP Lightning checkout).
//
// Default: the platform Cashu mint issues the invoice (existing behavior —
// request binding is enforced server-side because the mint cannot embed a
// caller-supplied description hash; see utils/x402/server.ts).
//
// Pro sellers can configure their own LNbits instance. Its invoice API
// accepts a caller-supplied `description_hash`, so seller-authority invoices
// embed the x402 request hash directly in the signed invoice — fully
// spec-strict binding — and funds land on the seller's own Lightning node.

import { decodeBolt11 } from "./bolt11";
import { X402_INVOICE_EXPIRY_SECONDS, X402_LNBTC_MAINNET } from "./constants";
import {
  decryptAuthorityApiKey,
  getSellerX402Authority,
} from "@/utils/db/x402-service";
import { isPubkeyProEntitled } from "@/utils/pro/membership";
import { safeFetch } from "@/utils/url-safety";

export type InvoiceAuthority =
  | { kind: "mint" }
  | { kind: "lnbits"; url: string; apiKey: string };

export class X402AuthorityError extends Error {}

/**
 * Resolve which invoice authority serves this seller. A configured custom
 * authority only activates while the seller is Pro-entitled; a lapsed
 * seller's orders fall back to the platform mint (their funds destination
 * never silently changes without losing the feature first).
 *
 * A transient entitlement/config lookup error THROWS: silently falling back
 * to the mint would move settlement to a different destination than the
 * seller configured, so a misconfigured/unreachable state fails loudly.
 */
export async function resolveInvoiceAuthority(
  sellerPubkey: string
): Promise<InvoiceAuthority> {
  const config = await getSellerX402Authority(sellerPubkey);
  if (!config) return { kind: "mint" };
  const entitled = await isPubkeyProEntitled(sellerPubkey);
  if (!entitled) return { kind: "mint" };
  return {
    kind: "lnbits",
    url: config.url,
    apiKey: decryptAuthorityApiKey(config),
  };
}

export interface LnbitsIssuedInvoice {
  invoice: string;
  paymentHash: string;
  payTo: string;
  expiresAt: string;
  expirySeconds: number;
}

/**
 * Create an invoice on the seller's LNbits node with the x402 request hash
 * embedded as the BOLT11 description hash. Verifies the returned invoice
 * actually carries the binding and the exact amount before handing it out —
 * a node that ignores description_hash must never produce a challenge we
 * would later settle as strictly bound.
 */
export async function issueLnbitsInvoice(args: {
  url: string;
  apiKey: string;
  amountSats: number;
  requestHash: string;
  expirySeconds?: number;
}): Promise<LnbitsIssuedInvoice> {
  const expirySeconds = args.expirySeconds ?? X402_INVOICE_EXPIRY_SECONDS;
  const base = args.url.replace(/\/+$/, "");
  let response: Response;
  try {
    response = await safeFetch(`${base}/api/v1/payments`, {
      method: "POST",
      accept: "application/json",
      timeoutMs: 10000,
      headers: {
        "X-Api-Key": args.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        out: false,
        amount: args.amountSats,
        unit: "sat",
        memo: "x402 payment",
        description_hash: args.requestHash,
        expiry: expirySeconds,
      }),
    });
  } catch (error) {
    throw new X402AuthorityError(
      `LNbits invoice request failed: ${
        error instanceof Error ? error.message : "unknown error"
      }`
    );
  }
  if (!response.ok) {
    throw new X402AuthorityError(
      `LNbits invoice request returned HTTP ${response.status}`
    );
  }
  const data = (await response.json().catch(() => null)) as {
    payment_hash?: string;
    payment_request?: string;
    bolt11?: string;
  } | null;
  const invoice = data?.payment_request ?? data?.bolt11;
  if (!invoice || typeof invoice !== "string") {
    throw new X402AuthorityError("LNbits response did not include an invoice");
  }

  const decoded = decodeBolt11(invoice);
  if (decoded.amountMsat !== BigInt(args.amountSats) * 1000n) {
    throw new X402AuthorityError(
      "LNbits invoice amount does not match the charge"
    );
  }
  if (decoded.currency !== "bc") {
    throw new X402AuthorityError("LNbits invoice is not a mainnet invoice");
  }
  if (decoded.descriptionHash !== args.requestHash.toLowerCase()) {
    throw new X402AuthorityError(
      "LNbits invoice did not embed the x402 request binding"
    );
  }
  const expiresAt = new Date(
    (decoded.timestamp + decoded.expirySeconds) * 1000
  ).toISOString();
  return {
    invoice,
    paymentHash: decoded.paymentHash,
    payTo: decoded.payeeNodeKey,
    expiresAt,
    expirySeconds: decoded.expirySeconds,
  };
}

/** Poll the seller's LNbits node for payment of a previously issued invoice. */
export async function checkLnbitsPayment(args: {
  url: string;
  apiKey: string;
  paymentHash: string;
}): Promise<{ paid: boolean; preimage?: string }> {
  const base = args.url.replace(/\/+$/, "");
  const response = await safeFetch(
    `${base}/api/v1/payments/${args.paymentHash}`,
    {
      accept: "application/json",
      timeoutMs: 10000,
      headers: { "X-Api-Key": args.apiKey },
    }
  );
  if (!response.ok) {
    throw new X402AuthorityError(
      `LNbits payment check returned HTTP ${response.status}`
    );
  }
  const data = (await response.json().catch(() => null)) as {
    paid?: boolean;
    preimage?: string;
    details?: { status?: string };
  } | null;
  const paid = data?.paid === true || data?.details?.status === "success";
  const preimage =
    typeof data?.preimage === "string" && /^[0-9a-f]{64}$/i.test(data.preimage)
      ? data.preimage.toLowerCase()
      : undefined;
  return { paid, ...(preimage ? { preimage } : {}) };
}

export { X402_LNBTC_MAINNET };
