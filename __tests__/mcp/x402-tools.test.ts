// Fault-injection tests for the pay_x402_request tool: the failure modes an
// adversarial review reproduced — a paid melt followed by a non-2xx merchant
// acknowledgement, an ack transport exception, and a wallet-state deletion
// failure — must surface as recoverable, proof-preserving results, never as
// generic errors that drop the preimage or hide stale spent proofs.

import { encodePaymentRequiredHeader } from "@/utils/x402/types";
import { X402_HEADERS } from "@/utils/x402/constants";

const FIXTURE = {
  invoice:
    "lnbc250n1p4ta2gqpp5fwcxlrjw8fm3t5sp64eap2jzxa3w2hdt6cdzcq3837jke3kjjnsqhp5nl3vhw262vvaccprhdszgtjsvfcsjxkwx696y00axeflclqqz08qxqrrsscqpfuv50sphk9dnjypn94zwxapu6w7ren0n30dm36gr5seuqz8786uh5856y9ypr4tadlmgsr5dn2fpymvzuaxvm7jfuum7xm9462zx5hcgqqdxmwz",
  preimage: "0707070707070707070707070707070707070707070707070707070707070707",
  paymentHash:
    "4bb06f8e4e3a7715d201d573d0aa423762e55dabd61a2c02278fa56cc6d294e0",
  payeeNodeKey:
    "03e7156ae33b0a208d0744199163177e909e80176e55d97a2f221ede0f934dd9ad",
  timestamp: 1790880000,
};

const MINT = "https://mint.minibits.cash/Bitcoin";
const PUB = "ab".repeat(32);

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
jest.mock("@cashu/cashu-ts", () => {
  class HttpResponseError extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  }
  class MintOperationError extends Error {
    code: number;
    constructor(c: number, d: string) {
      super(d);
      this.code = c;
    }
  }
  class Mint {
    constructor(_url: string, _opts?: any) {}
  }
  class Wallet {
    constructor(_mint: any) {}
    async loadMint() {}
    async createMeltQuoteBolt11() {
      return {
        quote: "q1",
        amount: { toNumber: () => 25 },
        fee_reserve: { toNumber: () => 1 },
      };
    }
  }
  return {
    Mint,
    Wallet,
    HttpResponseError,
    MintOperationError,
    JSONInt: JSON,
  };
});
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

function fakeResponse(status: number, header?: string): any {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (k: string) =>
        k.toLowerCase() === X402_HEADERS.paymentRequired.toLowerCase()
          ? (header ?? null)
          : null,
    },
    text: async () => "merchant-body",
    json: async () => ({}),
  };
}

function makeHandler() {
  let cb: any;
  registerX402Tools((_n: string, _d: string, _s: any, handler: any) => {
    cb = handler;
  }, {} as any);
  return cb;
}

const OLD_EVENT = {
  pubkey: PUB,
  id: "old1",
  content: JSON.stringify({ mint: MINT, proofs: [{ amount: 100 }] }),
};

describe("pay_x402_request fault handling", () => {
  let nowSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    // The fixture invoice is real but time-bound; pin the clock inside its
    // validity window.
    nowSpy = jest.spyOn(Date, "now").mockReturnValue(FIXTURE.timestamp * 1000);
    mockSafeMeltProofs.mockResolvedValue({
      status: "paid",
      meltQuote: { quote: "q1" },
      meltResponse: { quote: { payment_preimage: FIXTURE.preimage } },
      changeProofs: [{ amount: 74 }],
    });
    mockSignAndPublishEvent.mockResolvedValue({ id: "newevt" });
    mockDeleteCachedEventsByIds.mockResolvedValue(undefined);
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  function setupFetch(second: any) {
    mockSafeFetch
      .mockResolvedValueOnce(fakeResponse(402, challengeHeader()))
      .mockImplementationOnce(async () =>
        typeof second === "function" ? second() : second
      );
  }

  function setupWalletCache(postDeleteRemaining: any[]) {
    mockFetchCachedEvents
      .mockResolvedValueOnce([OLD_EVENT]) // load proofs
      .mockResolvedValueOnce([OLD_EVENT, { id: "newevt" }]) // confirm replacement
      .mockResolvedValueOnce(postDeleteRemaining); // deletion postcondition
  }

  const PARAMS = {
    url: "https://merchant.example/paid",
    method: "GET" as const,
    maxAmountSats: 100,
  };

  it("non-2xx acknowledgement reports paid-but-unacknowledged with recoverable proof", async () => {
    setupFetch(fakeResponse(500));
    setupWalletCache([{ id: "newevt" }]);
    const result = await makeHandler()(PARAMS);
    const body = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(false);
    expect(body.paid).toBe(true);
    expect(body.acknowledged).toBe(false);
    expect(body.preimage).toBe(FIXTURE.preimage);
    expect(body.paymentHash).toBe(FIXTURE.paymentHash);
    expect(body.paymentSignatureHeader).toBeTruthy();
    expect(body.retry).toMatch(/do NOT pay again/i);
    expect(body.walletPersistError).toBeUndefined();
  });

  it("ack transport exception retains the proof instead of a generic error", async () => {
    setupFetch(() => {
      throw new Error("socket hangup");
    });
    setupWalletCache([{ id: "newevt" }]);
    const result = await makeHandler()(PARAMS);
    const body = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(false);
    expect(body.paid).toBe(true);
    expect(body.acknowledged).toBe(false);
    expect(body.ackError).toMatch(/socket hangup/);
    expect(body.preimage).toBe(FIXTURE.preimage);
  });

  it("surviving spent events surface walletPersistError on a successful result", async () => {
    setupFetch(fakeResponse(200));
    setupWalletCache([OLD_EVENT, { id: "newevt" }]); // old1 survives deletion
    const result = await makeHandler()(PARAMS);
    const body = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(false);
    expect(body.paid).toBe(true);
    expect(body.acknowledged).toBe(true);
    expect(body.walletPersistError).toMatch(/could not be deleted/);
  });

  it("unconfirmed replacement event keeps spent proofs and reports the failure", async () => {
    setupFetch(fakeResponse(200));
    mockFetchCachedEvents
      .mockResolvedValueOnce([OLD_EVENT]) // load proofs
      .mockResolvedValueOnce([OLD_EVENT]); // replacement NOT cached
    const result = await makeHandler()(PARAMS);
    const body = JSON.parse(result.content[0].text);
    expect(mockDeleteCachedEventsByIds).not.toHaveBeenCalled();
    expect(body.walletPersistError).toMatch(/not durably recorded/);
    expect(body.preimage).toBe(FIXTURE.preimage);
  });
});
