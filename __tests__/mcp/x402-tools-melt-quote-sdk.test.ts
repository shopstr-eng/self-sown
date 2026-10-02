// Regression guard for pay_x402_request's MELT-QUOTE CONSUMPTION against the
// INSTALLED @cashu/cashu-ts — the complement to x402-guarded-mint-request
// (which guards the transport) and x402-tools.test.ts (which mocks the whole
// SDK).
//
// The tool reads the mint's melt quote through casts tsc cannot check:
//   (meltQuote.amount as any).toNumber()
//   (meltQuote.fee_reserve as any)?.toNumber?.()
// A cashu-ts upgrade that returns plain numbers/bigints instead of Amount
// objects — or renames loadMint / createMeltQuoteBolt11 / their response
// fields — would keep the fully-mocked suite green and break live payments.
// Here the REAL SDK Mint/Wallet run over the real guarded transport with only
// safeFetch stubbed at the network boundary, serving protocol-shaped (NUT-05/
// NUT-06) mint responses, so any such drift fails loudly.
//
// safeMeltProofs stays mocked in THIS suite: real melt execution (signed
// change, DLEQ verification, preimage extraction) is guarded by the sibling
// x402-tools-melt-exec-sdk suite. What is guarded here is the quote →
// spend-cap → melt hand-off.

import {
  Amount,
  HttpResponseError,
  JSONInt,
  Mint,
  MintOperationError,
  Wallet,
  deriveKeysetId,
} from "@cashu/cashu-ts";
import { createGuardedMintRequest } from "@/utils/x402/guarded-mint-request";
import { encodePaymentRequiredHeader } from "@/utils/x402/types";
import { X402_HEADERS } from "@/utils/x402/constants";

// Same time-bound mainnet invoice as the mocked fault suite (25 sats).
const FIXTURE = {
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

const MINT_URL = "https://mint.minibits.cash/Bitcoin";
const MERCHANT_URL = "https://merchant.example/paid";
const PUB = "ab".repeat(32);

// A real mint keyset the SDK's KeyChain will accept: valid curve points, and
// the keyset id derived at runtime via the SDK's own deriveKeysetId so this
// plumbing tracks the installed SDK (an id-derivation change is out of scope
// here — the contract under test is the melt-quote response shape).
const KEYS: Record<string, string> = {
  "1": "0220c486d6f07a296e3a5a341b3253b8a14666489f5ad040160472a6241e420e79",
  "2": "02ed0be084e6f6d6da3d286d34be66a2b17a44afd2efe284b2905658061a497744",
  "4": "03ff5c14bb7c7dc29e1cebe93a2773af3f02d0c1e4e20d6c8941f26b6c5f53cc99",
  "8": "03d20d27f4447cdf3df68089510faed6dd41069e47daaefe23982ef27f97637b30",
  "16": "033c591fde555449348fe359e8ad9d8cee9ce1166b6e87ce5621bdcf9519b997b2",
  "32": "020d2fd5ccd58eb6c5de701890335274141df2baacd3ea44904d3a320465d885dc",
  "64": "03a52a8fa25e35a3f703ec65c3a868ac90b8cca261715ab7f8674aef69af753d05",
};
const KEYSET_ID = deriveKeysetId(KEYS);

// NUT-06 mint info advertising bolt11 melt support for sat — required by the
// SDK's requireSupport("melt", "bolt11") gate inside createMeltQuoteBolt11.
const MINT_INFO = {
  name: "x402 regression mint",
  pubkey: KEYS["1"],
  version: "x402-regression/1.0",
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

/** NUT-05 wire shape for POST /v1/melt/quote/bolt11. */
function meltQuoteWire(amount: number, feeReserve: number) {
  return {
    quote: "q1",
    request: FIXTURE.invoice,
    amount,
    fee_reserve: feeReserve,
    unit: "sat",
    state: "UNPAID",
    expiry: FIXTURE.timestamp + 3600,
  };
}

const mockSafeFetch = jest.fn();
const mockFetchCachedEvents = jest.fn();
const mockDeleteCachedEventsByIds = jest.fn();
const mockSignAndPublishEvent = jest.fn();
const mockSafeMeltProofs = jest.fn();

jest.mock("@/utils/mcp/auth", () => ({
  canUsePurchaseTools: () => true,
  getAgentSigner: async () => ({
    signer: {
      getPubKey: () => PUB,
      decrypt: (_p: string, content: string) => content,
      encrypt: (_p: string, content: string) => content,
      sign: (e: any) => ({ ...e, id: "newevt", pubkey: PUB }),
    },
  }),
}));
jest.mock("@/utils/url-safety", () => {
  const actual = jest.requireActual("@/utils/url-safety");
  return {
    ...actual,
    safeFetch: (...args: any[]) => mockSafeFetch(...args),
    isSafePublicHostname: async () => true,
  };
});
// NOTE: @cashu/cashu-ts is deliberately NOT mocked — that is the point.
jest.mock("@/utils/db/db-service", () => ({
  fetchCachedEvents: (...args: any[]) => mockFetchCachedEvents(...args),
  deleteCachedEventsByIds: (...args: any[]) =>
    mockDeleteCachedEventsByIds(...args),
}));
jest.mock("@/utils/cashu/mint-retry-service", () => ({
  withMintRetry: (fn: any) => fn(),
}));
jest.mock("@/utils/cashu/melt-retry-service", () => ({
  safeMeltProofs: (...args: any[]) => mockSafeMeltProofs(...args),
}));
jest.mock("@/utils/mcp/nostr-signing", () => ({
  signAndPublishEvent: (...args: any[]) => mockSignAndPublishEvent(...args),
}));

const { registerX402Tools } = require("@/mcp/tools/x402-tools");

function challengeHeader(): string {
  return encodePaymentRequiredHeader({
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: "lnbtc:000000000019d6689c085ae165831e93",
        asset: "BTC",
        amount: "25000",
        payTo: FIXTURE.payeeNodeKey,
        maxTimeoutSeconds: 3600,
        extra: {
          assetTransferMethod: "bolt11",
          paymentFlow: "upfront",
          invoice: FIXTURE.invoice,
        },
      } as any,
    ],
  } as any);
}

function fakeResponse(
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

function makeHandler() {
  let cb: any;
  registerX402Tools((_n: string, _d: string, _s: any, handler: any) => {
    cb = handler;
  }, {} as any);
  return cb;
}

/** Proof event holding `sats` at the wallet mint. */
function walletEvent(sats: number, id = "old1") {
  return {
    pubkey: PUB,
    id,
    content: JSON.stringify({
      mint: MINT_URL,
      proofs: [{ amount: sats }],
    }),
  };
}

describe("pay_x402_request — real-SDK melt-quote consumption", () => {
  let nowSpy: jest.SpyInstance;
  let merchantCalls: number;
  let meltQuoteRequestBody: string | undefined;
  let meltQuoteWireResponse: ReturnType<typeof meltQuoteWire>;

  beforeEach(() => {
    // mockReset, not clearAllMocks: the error-path tests consume fewer of the
    // queued fetchCachedEvents responses than they set up, and clearAllMocks
    // leaves the once-queue intact — stale wallet events would leak into the
    // next test.
    for (const m of [
      mockSafeFetch,
      mockFetchCachedEvents,
      mockDeleteCachedEventsByIds,
      mockSignAndPublishEvent,
      mockSafeMeltProofs,
    ]) {
      m.mockReset();
    }
    // The fixture invoice is real but time-bound; pin the clock inside its
    // validity window.
    nowSpy = jest.spyOn(Date, "now").mockReturnValue(FIXTURE.timestamp * 1000);
    merchantCalls = 0;
    meltQuoteRequestBody = undefined;
    meltQuoteWireResponse = meltQuoteWire(25, 1);

    mockSafeMeltProofs.mockResolvedValue({
      status: "paid",
      meltQuote: { quote: "q1" },
      meltResponse: { quote: { payment_preimage: FIXTURE.preimage } },
      changeProofs: [{ amount: 74 }],
    });
    mockSignAndPublishEvent.mockResolvedValue({ id: "newevt" });
    mockDeleteCachedEventsByIds.mockResolvedValue(undefined);

    // One dispatcher for BOTH legs of the tool's network traffic: the x402
    // merchant fetches and the SDK's mint protocol calls (which flow through
    // the real guarded transport → safeFetch).
    mockSafeFetch.mockImplementation(async (url: string, init?: any) => {
      if (url === MERCHANT_URL) {
        merchantCalls++;
        if (merchantCalls === 1) {
          return fakeResponse(402, "payment required", {
            [X402_HEADERS.paymentRequired.toLowerCase()]: challengeHeader(),
          });
        }
        return fakeResponse(200, "paid-content");
      }
      if (typeof url === "string" && url.startsWith(MINT_URL)) {
        const path = url.slice(MINT_URL.length);
        if (path === "/v1/info") {
          return fakeResponse(200, JSON.stringify(MINT_INFO));
        }
        if (path === "/v1/keysets") {
          return fakeResponse(
            200,
            JSON.stringify({
              keysets: [
                {
                  id: KEYSET_ID,
                  unit: "sat",
                  active: true,
                  input_fee_ppk: 0,
                },
              ],
            })
          );
        }
        if (path === "/v1/keys" || path.startsWith("/v1/keys/")) {
          return fakeResponse(
            200,
            JSON.stringify({
              keysets: [{ id: KEYSET_ID, unit: "sat", keys: KEYS }],
            })
          );
        }
        if (path === "/v1/melt/quote/bolt11") {
          meltQuoteRequestBody = init?.body;
          return fakeResponse(200, JSON.stringify(meltQuoteWireResponse));
        }
      }
      throw new Error(`unexpected fetch in real-SDK test: ${url}`);
    });
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  function setupWalletCache(event: any, postDeleteRemaining: any[]) {
    mockFetchCachedEvents
      .mockResolvedValueOnce([event]) // load proofs
      .mockResolvedValueOnce([event, { id: "newevt" }]) // confirm replacement
      .mockResolvedValueOnce(postDeleteRemaining); // deletion postcondition
  }

  it("drives the full tool flow against the real SDK and reports amount + fee from its Amount fields", async () => {
    setupWalletCache(walletEvent(100), [{ id: "newevt" }]);
    const result = await makeHandler()({
      url: MERCHANT_URL,
      method: "GET",
      maxAmountSats: 100,
    });
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(false);
    expect(body.paid).toBe(true);
    expect(body.acknowledged).toBe(true);
    // The spend arithmetic ran on the real SDK quote: amountSats/feeSats in
    // the result come from Amount.toNumber() on createMeltQuoteBolt11's
    // response. If an upgrade returned plain numbers, .toNumber() would throw
    // and this would surface as a generic "x402 payment failed" instead.
    expect(body.amountSats).toBe(25);
    expect(body.feeSats).toBe(1);
    expect(body.preimage).toBe(FIXTURE.preimage);
    expect(body.paymentHash).toBe(FIXTURE.paymentHash);

    // The mint saw a protocol-shaped quote request (parsed with the SDK's own
    // JSONInt, the same parser the transport uses).
    expect(typeof meltQuoteRequestBody).toBe("string");
    const sentQuote = JSONInt.parse(meltQuoteRequestBody as string) as any;
    expect(sentQuote.unit).toBe("sat");
    expect(sentQuote.request).toBe(FIXTURE.invoice);

    // The quote handed to safeMeltProofs is the real SDK-normalized response:
    // its amount/fee_reserve must still be Amount-shaped.
    const handedQuote = mockSafeMeltProofs.mock.calls[0]?.[1];
    expect(handedQuote).toBeDefined();
    expect(handedQuote.amount).toBeInstanceOf(Amount);
    expect(handedQuote.amount.toNumber()).toBe(25);
    expect(handedQuote.fee_reserve).toBeInstanceOf(Amount);
    expect(handedQuote.fee_reserve.toNumber()).toBe(1);
  });

  it("binds the spend cap to the real quote total (amount + fee reserve), not the advertised amount", async () => {
    setupWalletCache(walletEvent(100), [{ id: "newevt" }]);
    const result = await makeHandler()({
      url: MERCHANT_URL,
      method: "GET",
      // Invoice is 25 sats — under this cap — but the quote total is 26.
      maxAmountSats: 25,
    });
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(body.error).toBe("Amount above spend cap");
    // The exact totals in the message are computed from the real SDK Amount
    // fields; a drifted shape cannot produce them.
    expect(body.details).toContain("26 sats");
    expect(body.details).toContain("25 sat cap");
    expect(mockSafeMeltProofs).not.toHaveBeenCalled();
  });

  it("compares wallet balance against the real quote total before melting", async () => {
    setupWalletCache(walletEvent(25), [{ id: "newevt" }]);
    const result = await makeHandler()({
      url: MERCHANT_URL,
      method: "GET",
      maxAmountSats: 100,
    });
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(body.error).toBe("Insufficient balance");
    expect(body.details).toContain("Need 26 sats");
    expect(mockSafeMeltProofs).not.toHaveBeenCalled();
  });

  it("real Wallet exposes loadMint/createMeltQuoteBolt11 and returns Amount-shaped quote fields", async () => {
    // The same construction the tool performs, asserted directly so an SDK
    // drift fails here with a precise message rather than a generic tool
    // error.
    const wallet = new Wallet(
      new Mint(MINT_URL, {
        customRequest: createGuardedMintRequest({
          JSONInt,
          HttpResponseError,
          MintOperationError,
        }),
      })
    );
    expect(typeof wallet.loadMint).toBe("function");
    expect(typeof wallet.createMeltQuoteBolt11).toBe("function");

    await wallet.loadMint();
    const quote = await wallet.createMeltQuoteBolt11(FIXTURE.invoice);

    expect(typeof (quote.amount as any)?.toNumber).toBe("function");
    expect(quote.amount).toBeInstanceOf(Amount);
    expect(quote.amount.toNumber()).toBe(25);
    expect(typeof (quote.fee_reserve as any)?.toNumber).toBe("function");
    expect(quote.fee_reserve).toBeInstanceOf(Amount);
    expect(quote.fee_reserve.toNumber()).toBe(1);
    expect(quote.quote).toBe("q1");
  });
});
