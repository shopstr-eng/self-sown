// Shared protocol-mint stub for the x402 REAL-SDK regression suites
// (__tests__/mcp/x402-tools-melt-quote-sdk.test.ts and
// __tests__/mcp/x402-tools-melt-exec-sdk.test.ts).
//
// Both suites run the REAL @cashu/cashu-ts over the real guarded transport
// with only safeFetch stubbed at the network boundary, serving
// protocol-shaped (NUT-05/NUT-06) mint responses. The wire shapes below are
// the SINGLE SOURCE OF TRUTH for that plumbing: a protocol-shape fix applied
// here reaches both suites, where the old per-suite copies could silently
// drift apart and leave one suite guarding a stale contract.
//
// Suite-specific pieces stay in the suites: the quote suite's static keyset
// and mocked safeMeltProofs, and the exec suite's in-test mint keys, real
// melt signing (NUT-08/NUT-12), and drift-throwing melt handler.

import {
  HttpResponseError,
  JSONInt,
  Mint,
  MintOperationError,
  Wallet,
} from "@cashu/cashu-ts";
import { createGuardedMintRequest } from "@/utils/x402/guarded-mint-request";
import { encodePaymentRequiredHeader } from "@/utils/x402/types";
import { X402_HEADERS } from "@/utils/x402/constants";

// Time-bound mainnet invoice shared by all x402 suites (25 sats). It is real
// but expires, so suites pin Date.now() inside its validity window.
export const X402_INVOICE_FIXTURE = {
  invoice:
    "lnbc250n1p4ta2gqpp5fwcxlrjw8fm3t5sp64eap2jzxa3w2hdt6cdzcq3837jke3kjjnsqhp5nl3vhw262vvaccprhdszgtjsvfcsjxkwx696y00axeflclqqz08qxqrrsscqpfuv50sphk9dnjypn94zwxapu6w7ren0n30dm36gr5seuqz8786uh5856y9ypr4tadlmgsr5dn2fpymvzuaxvm7jfuum7xm9462zx5hcgqqdxmwz",
  preimage:
    "0707070707070707070707070707070707070707070707070707070707070707",
  paymentHash:
    "4bb06f8e4e3a7715d201d573d0aa423762e55dabd61a2c02278fa56cc6d294e0",
  payeeNodeKey:
    "03e7156ae33b0a208d0744199163177e909e80176e55d97a2f221ede0f934dd9ad",
  timestamp: 1790880000,
};

export const MINT_URL = "https://mint.minibits.cash/Bitcoin";
export const MERCHANT_URL = "https://merchant.example/paid";
export const AGENT_PUBKEY = "ab".repeat(32);

/** Minimal Response-shaped stub the guarded transport consumes. */
export function fakeResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {}
): any {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (k: string) => headers[k.toLowerCase()] ?? null,
    },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

/**
 * NUT-06 mint info advertising bolt11 mint+melt support for sat — required
 * by the SDK's requireSupport("melt", "bolt11") gate inside
 * createMeltQuoteBolt11 / meltProofsBolt11.
 */
export function buildMintInfo({
  pubkey,
  name,
  version,
}: {
  pubkey: string;
  name: string;
  version: string;
}) {
  return {
    name,
    pubkey,
    version,
    description: "protocol-shaped mint stub",
    contact: [],
    motd: "",
    nuts: {
      "4": { methods: [{ method: "bolt11", unit: "sat" }], disabled: false },
      "5": { methods: [{ method: "bolt11", unit: "sat" }], disabled: false },
      "7": { supported: true },
      "8": { supported: true },
      "9": { supported: true },
      "10": { supported: true },
      "11": { supported: true },
      "12": { supported: true },
    },
  };
}

/**
 * NUT-05 melt-quote wire shape — shared by the create-quote response, the
 * melt response's merged quote, and the quote-status check.
 */
export function meltQuoteWire({
  amount,
  feeReserve,
  state = "UNPAID",
  preimage,
  quote = "q1",
}: {
  amount: number;
  feeReserve: number;
  state?: "UNPAID" | "PAID";
  preimage?: string;
  quote?: string;
}) {
  return {
    quote,
    request: X402_INVOICE_FIXTURE.invoice,
    amount,
    fee_reserve: feeReserve,
    unit: "sat",
    state,
    expiry: X402_INVOICE_FIXTURE.timestamp + 3600,
    ...(preimage ? { payment_preimage: preimage } : {}),
  };
}

/**
 * Serve the mint's static key material for one request path (the slice of
 * the URL after MINT_URL). Returns undefined for any other path so the
 * suite's dispatcher can handle the melt/quote endpoints itself.
 * `keys` is the amount→pubkey map served at /v1/keys.
 */
export function serveMintKeyMaterial(
  path: string,
  {
    mintInfo,
    keysetId,
    keys,
  }: {
    mintInfo: unknown;
    keysetId: string;
    keys: Record<string, string>;
  }
): any {
  if (path === "/v1/info") {
    return fakeResponse(200, JSON.stringify(mintInfo));
  }
  if (path === "/v1/keysets") {
    return fakeResponse(
      200,
      JSON.stringify({
        keysets: [{ id: keysetId, unit: "sat", active: true, input_fee_ppk: 0 }],
      })
    );
  }
  if (path === "/v1/keys" || path.startsWith("/v1/keys/")) {
    return fakeResponse(
      200,
      JSON.stringify({ keysets: [{ id: keysetId, unit: "sat", keys }] })
    );
  }
  return undefined;
}

/** 402 challenge for the fixture invoice, in the payment-required header. */
function challengeHeader(): string {
  return encodePaymentRequiredHeader({
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: "lnbtc:000000000019d6689c085ae165831e93",
        asset: "BTC",
        amount: "25000",
        payTo: X402_INVOICE_FIXTURE.payeeNodeKey,
        maxTimeoutSeconds: 3600,
        extra: {
          assetTransferMethod: "bolt11",
          paymentFlow: "upfront",
          invoice: X402_INVOICE_FIXTURE.invoice,
        },
      } as any,
    ],
  } as any);
}

/**
 * The merchant leg of the tool's network traffic: first fetch → 402 with the
 * x402 challenge, every later fetch → 200 paid-content. Returns undefined for
 * non-merchant URLs so the suite's mint dispatcher can take over.
 */
export function createMerchantDispatcher() {
  let calls = 0;
  return async (url: unknown): Promise<any> => {
    if (url !== MERCHANT_URL) return undefined;
    calls++;
    if (calls === 1) {
      return fakeResponse(402, "payment required", {
        [X402_HEADERS.paymentRequired.toLowerCase()]: challengeHeader(),
      });
    }
    return fakeResponse(200, "paid-content");
  };
}

/** Capture the pay_x402_request handler out of registerX402Tools. */
export function makeX402ToolHandler(registerX402Tools: any) {
  let cb: any;
  registerX402Tools((_n: string, _d: string, _s: any, handler: any) => {
    cb = handler;
  }, {} as any);
  return cb;
}

/** A kind-7375-style wallet event holding `proofs` at the stub mint. */
export function walletProofsEvent(proofs: any[], id = "old1") {
  return {
    pubkey: AGENT_PUBKEY,
    id,
    content: JSON.stringify({ mint: MINT_URL, proofs }),
  };
}

/**
 * The three fetchCachedEvents responses the tool's wallet-accounting path
 * consumes in order: load proofs → confirm replacement → deletion
 * postcondition. (Structural param type keeps this helper free of jest
 * types.)
 */
export function stubWalletCache(
  mockFetchCachedEvents: { mockResolvedValueOnce: (v: any) => any },
  event: any,
  postDeleteRemaining: any[]
) {
  mockFetchCachedEvents
    .mockResolvedValueOnce([event])
    .mockResolvedValueOnce([event, { id: "newevt" }])
    .mockResolvedValueOnce(postDeleteRemaining);
}

/**
 * The same Wallet construction the tool performs: real SDK Mint/Wallet over
 * the real guarded transport (safeFetch stays stubbed by the suite).
 */
export function createRealMintWallet() {
  return new Wallet(
    new Mint(MINT_URL, {
      customRequest: createGuardedMintRequest({
        JSONInt,
        HttpResponseError,
        MintOperationError,
      }),
    })
  );
}
