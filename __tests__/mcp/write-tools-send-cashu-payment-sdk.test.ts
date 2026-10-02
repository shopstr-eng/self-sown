// Regression guard for send_cashu_payment's MELT-QUOTE CONSUMPTION against the
// INSTALLED @cashu/cashu-ts — the sibling of x402-tools-melt-quote-sdk (which
// guards pay_x402_request) and the complement to
// write-tools-send-cashu-payment-ssrf (which mocks the whole SDK to guard the
// URL pre-check).
//
// The tool reads the mint's melt quote through casts tsc cannot check:
//   (meltQuote.amount as any).toNumber()
//   (meltQuote.fee_reserve as any)?.toNumber?.()
// and reports `{ amount, fee, change }` computed from those casts plus
// sumProofAmounts(meltOutcome.changeProofs). A cashu-ts upgrade that returns
// plain numbers/bigints instead of Amount objects — or renames loadMint /
// createMeltQuoteBolt11 / their response fields — would keep the fully-mocked
// suites green and break live agent payments. Here the REAL SDK Mint/Wallet
// run over the real guarded transport with only safeFetch stubbed at the
// network boundary, serving protocol-shaped (NUT-05/NUT-06) mint responses,
// so any such drift fails loudly.
//
// safeMeltProofs stays mocked in THIS suite: real melt execution (signed
// change, DLEQ verification, preimage extraction) is guarded by the
// x402-tools-melt-exec-sdk suite. What is guarded here is the tool's
// quote → balance-check → melt hand-off and its result arithmetic.

import { Amount, deriveKeysetId, JSONInt } from "@cashu/cashu-ts";

// Same time-bound mainnet invoice as the x402 sibling suites (25 sats).
const FIXTURE = {
  invoice:
    "lnbc250n1p4ta2gqpp5fwcxlrjw8fm3t5sp64eap2jzxa3w2hdt6cdzcq3837jke3kjjnsqhp5nl3vhw262vvaccprhdszgtjsvfcsjxkwx696y00axeflclqqz08qxqrrsscqpfuv50sphk9dnjypn94zwxapu6w7ren0n30dm36gr5seuqz8786uh5856y9ypr4tadlmgsr5dn2fpymvzuaxvm7jfuum7xm9462zx5hcgqqdxmwz",
  timestamp: 1790880000,
};

const MINT_URL = "https://mint.minibits.cash/Bitcoin";
const PUB = "b".repeat(64);

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
  name: "send_cashu_payment regression mint",
  pubkey: KEYS["1"],
  version: "send-cashu-regression/1.0",
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
const mockSafeMeltProofs = jest.fn();

jest.mock("@/utils/mcp/auth", () => ({
  canUsePurchaseTools: () => true,
  canUseSellerReadTools: () => true,
  canUseSellerWriteTools: (k: any) => k.permissions === "full_access",
  getAgentSigner: async () => ({
    signer: {
      getPubKey: () => PUB,
      decrypt: (_p: string, content: string) => content,
      encrypt: (_p: string, content: string) => content,
      sign: (e: any) => ({ ...e, id: "newevt", pubkey: PUB }),
    },
    pubkey: PUB,
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
// db-service is imported at module scope by write-tools (getDbPool et al), so
// the factory must provide every export the module touches, not just the ones
// this test drives.
jest.mock("@/utils/db/db-service", () => ({
  cacheEvent: jest.fn(),
  fetchAllProfilesFromDb: jest.fn(),
  fetchCachedEvents: (...args: any[]) => mockFetchCachedEvents(...args),
  fetchCommentsByReviewIds: jest.fn(),
  createEmailFlow: jest.fn(),
  getEmailFlows: jest.fn(),
  getEmailFlow: jest.fn(),
  updateEmailFlow: jest.fn(),
  deleteEmailFlow: jest.fn(),
  createFlowStep: jest.fn(),
  getFlowSteps: jest.fn(),
  updateFlowStep: jest.fn(),
  deleteFlowStep: jest.fn(),
  getFlowEnrollments: jest.fn(),
  getSubscriptionsBySellerPubkey: jest.fn(),
  getStripeConnectAccount: jest.fn(),
  getDbPool: jest.fn(),
  markMessagesAsRead: jest.fn(),
}));
// Single-attempt passthrough: retry timing is covered elsewhere; here one
// attempt keeps the failure paths deterministic and fast.
jest.mock("@/utils/cashu/mint-retry-service", () => ({
  withMintRetry: (fn: any) => fn(),
}));
jest.mock("@/utils/cashu/melt-retry-service", () => ({
  safeMeltProofs: (...args: any[]) => mockSafeMeltProofs(...args),
}));
jest.mock("@/utils/mcp/nostr-signing", () => ({
  McpNostrSigner: jest.fn(),
  McpRelayManager: jest.fn(),
  signAndPublishEvent: jest.fn(),
}));

const { registerWriteTools } = require("@/mcp/tools/write-tools");

type Result = { content: Array<{ text: string }>; isError?: boolean };
type Callback = (
  args: Record<string, unknown>,
  extra?: unknown
) => Promise<Result>;

function tool(name: string): Callback {
  const callbacks = new Map<string, Callback>();
  const server = {
    registerTool: jest.fn((n: string, _o: unknown, cb: Callback) =>
      callbacks.set(n, cb)
    ),
  };
  registerWriteTools(server, {
    id: 1,
    pubkey: PUB,
    permissions: "full_access",
  } as any);
  const cb = callbacks.get(name);
  if (!cb) throw new Error(`tool ${name} not registered`);
  return cb;
}

function payload(result: Result) {
  return JSON.parse(result.content[0]!.text);
}

function fakeResponse(status: number, body: string): any {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

describe("send_cashu_payment — real-SDK melt-quote consumption", () => {
  let nowSpy: jest.SpyInstance;
  let meltQuoteRequestBody: string | undefined;
  let meltQuoteWireResponse: ReturnType<typeof meltQuoteWire>;

  beforeEach(() => {
    for (const m of [
      mockSafeFetch,
      mockFetchCachedEvents,
      mockSafeMeltProofs,
    ]) {
      m.mockReset();
    }
    // The fixture invoice is real but time-bound; pin the clock inside its
    // validity window.
    nowSpy = jest.spyOn(Date, "now").mockReturnValue(FIXTURE.timestamp * 1000);
    meltQuoteRequestBody = undefined;
    meltQuoteWireResponse = meltQuoteWire(25, 1);

    mockSafeMeltProofs.mockResolvedValue({
      status: "paid",
      meltQuote: { quote: "q1" },
      meltResponse: { quote: { payment_preimage: "ab".repeat(32) } },
      changeProofs: [{ amount: 74 }],
    });

    mockSafeFetch.mockImplementation(async (url: string, init?: any) => {
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
                { id: KEYSET_ID, unit: "sat", active: true, input_fee_ppk: 0 },
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

  /** Wallet event holding `sats` at the tool's default mint. */
  function walletEvent(sats: number) {
    return {
      pubkey: PUB,
      id: "old1",
      content: JSON.stringify({
        mint: MINT_URL,
        proofs: [{ amount: sats, id: KEYSET_ID, secret: "s", C: "c" }],
      }),
    };
  }

  it("drives the tool against the real SDK and reports amount + fee + change from its Amount fields", async () => {
    mockFetchCachedEvents.mockResolvedValue([walletEvent(100)]);
    const result = await tool("send_cashu_payment")({
      invoice: FIXTURE.invoice,
    });
    const body = payload(result);

    expect(result.isError).toBeFalsy();
    // amount/fee in the result come from Amount.toNumber() on the real
    // createMeltQuoteBolt11 response. If an upgrade returned plain numbers,
    // .toNumber() would throw and this would surface as a generic "Failed to
    // send Cashu payment" instead.
    expect(body.paid).toBe(true);
    expect(body.amount).toBe(25);
    expect(body.fee).toBe(1);
    expect(body.change).toBe(74);
    expect(body.mintUrl).toBe(MINT_URL);

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

  it("binds the balance check to the real quote total (amount + fee reserve), not the invoice amount", async () => {
    // Wallet holds exactly the invoice amount (25) but the quote total is 26.
    mockFetchCachedEvents.mockResolvedValue([walletEvent(25)]);
    const result = await tool("send_cashu_payment")({
      invoice: FIXTURE.invoice,
    });
    const body = payload(result);

    expect(result.isError).toBe(true);
    expect(body.error).toBe("Insufficient balance");
    // The exact totals in the message are computed from the real SDK Amount
    // fields; a drifted shape cannot produce them.
    expect(body.details).toContain("Need 26 sats");
    expect(body.details).toContain("only have 25 sats");
    expect(mockSafeMeltProofs).not.toHaveBeenCalled();
  });

  it("surfaces a real melt failure with the outcome's status and message", async () => {
    mockFetchCachedEvents.mockResolvedValue([walletEvent(100)]);
    mockSafeMeltProofs.mockResolvedValue({
      status: "unpaid",
      errorMessage: "mint rejected the proofs",
      changeProofs: [],
    });
    const result = await tool("send_cashu_payment")({
      invoice: FIXTURE.invoice,
    });
    const body = payload(result);

    expect(result.isError).toBe(true);
    expect(body.error).toBe("Cashu payment failed");
    expect(body.details).toContain("mint rejected the proofs");
  });

  it("real Wallet exposes loadMint/createMeltQuoteBolt11 and returns Amount-shaped quote fields", async () => {
    // The same construction the tool performs, asserted directly so an SDK
    // drift fails here with a precise message rather than a generic tool
    // error. Reconstructed via the tool's own dynamic import path.
    const {
      Mint: CashuMint,
      Wallet: CashuWallet,
      HttpResponseError,
      MintOperationError,
      JSONInt: SdkJSONInt,
    } = await import("@cashu/cashu-ts");
    const { createGuardedMintRequest } =
      await import("@/utils/x402/guarded-mint-request");
    const wallet = new CashuWallet(
      new CashuMint(MINT_URL, {
        customRequest: createGuardedMintRequest({
          JSONInt: SdkJSONInt,
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
