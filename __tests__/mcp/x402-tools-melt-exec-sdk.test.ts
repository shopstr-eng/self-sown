// Regression guard for pay_x402_request's MELT EXECUTION against the
// INSTALLED @cashu/cashu-ts — the complement to x402-tools-melt-quote-sdk
// (which mocks safeMeltProofs and guards the quote → spend-cap → melt
// hand-off) and x402-tools.test.ts (which mocks the whole SDK).
//
// Here the REAL wallet.meltProofsBolt11 runs inside the REAL safeMeltProofs
// (@/utils/cashu/melt-retry-service is deliberately NOT mocked) against
// protocol-shaped NUT-05/NUT-08/NUT-12 mint responses served at the safeFetch
// boundary. The stub mint holds locally generated keys (createNewMintKeys)
// and signs the wallet's change blanks for real (createBlindSignature +
// createDLEQProof), so the SDK's request serialization, change-proof
// unblinding, and DLEQ verification genuinely execute. The stub THROWS on
// any melt-request shape drift, and the tests assert the response-side
// contract the tool consumes — meltResponse.quote.payment_preimage, the
// meltQuote.payment_preimage quote-status fallback, and spendable unblinded
// changeProofs — so an SDK upgrade that renames meltProofs fields or changes
// signature shapes fails here, not in live x402 payments.

import {
  Amount,
  HttpResponseError,
  JSONInt,
  Mint,
  MintOperationError,
  Wallet,
  blindMessage,
  createBlindSignature,
  createDLEQProof,
  createNewMintKeys,
  pointFromHex,
  serializeMintKeys,
  unblindSignature,
  verifyUnblindedSignature,
} from "@cashu/cashu-ts";
import { safeMeltProofs } from "@/utils/cashu/melt-retry-service";
import { createGuardedMintRequest } from "@/utils/x402/guarded-mint-request";
import { encodePaymentRequiredHeader } from "@/utils/x402/types";
import { X402_HEADERS } from "@/utils/x402/constants";

// Same time-bound mainnet invoice as the sibling suites (25 sats).
const FIXTURE = {
  invoice:
    "lnbc250n1p4ta2gqpp5fwcxlrjw8fm3t5sp64eap2jzxa3w2hdt6cdzcq3837jke3kjjnsqhp5nl3vhw262vvaccprhdszgtjsvfcsjxkwx696y00axeflclqqz08qxqrrsscqpfuv50sphk9dnjypn94zwxapu6w7ren0n30dm36gr5seuqz8786uh5856y9ypr4tadlmgsr5dn2fpymvzuaxvm7jfuum7xm9462zx5hcgqqdxmwz",
  preimage:
    "0707070707070707070707070707070707070707070707070707070707070707",
  timestamp: 1790880000,
};

const MINT_URL = "https://mint.minibits.cash/Bitcoin";
const MERCHANT_URL = "https://merchant.example/paid";
const PUB = "ab".repeat(32);

// The melt RESPONSE carries the invoice's preimage; the quote-STATUS check
// carries a different one so tests can prove which field the tool read.
const PREIMAGE = FIXTURE.preimage;
const FALLBACK_PREIMAGE = "09".repeat(32);

// Locally generated mint keys: the stub mint signs with the private half and
// the real wallet unblinds + DLEQ-verifies against the public half it fetches
// from /v1/keys. Derived at runtime via the SDK's own helpers so this plumbing
// tracks the installed SDK.
const MINT_KEYS = createNewMintKeys(7); // amounts 1..64
const KEYSET_ID = MINT_KEYS.keysetId;
const PUB_KEYS = serializeMintKeys(MINT_KEYS.pubKeys);

// NUT-06 mint info advertising bolt11 melt support for sat — required by the
// SDK's requireSupport("melt", "bolt11") gate inside meltProofsBolt11.
const MINT_INFO = {
  name: "x402 melt-exec regression mint",
  pubkey: PUB_KEYS["1"],
  version: "x402-melt-exec-regression/1.0",
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

function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

// A REAL proof minted in-test. The stub mint cryptographically verifies every
// input it is asked to melt, so a drift in the SDK's input serialization
// (renamed id/secret/C fields) fails here even though the wallet itself never
// verifies its own input signatures — the mint does.
function mintProof(amount: number) {
  const secret = amount.toString(16).padStart(2, "0").repeat(32);
  const { B_, r } = blindMessage(new TextEncoder().encode(secret));
  const priv = MINT_KEYS.privKeys[String(amount)];
  const pub = PUB_KEYS[String(amount)];
  if (!priv || !pub) throw new Error(`no mint key for amount ${amount}`);
  const signed = createBlindSignature(B_, priv, KEYSET_ID);
  const C = unblindSignature(signed.C_, r, pointFromHex(pub));
  return { id: KEYSET_ID, amount, secret, C: C.toHex(true) };
}

// 64 + 32 + 4 = 100 sats of wallet balance.
const WALLET_PROOFS = [mintProof(64), mintProof(32), mintProof(4)];

// Change the stub mint returns: inputs(100) − amount(25) − fee paid(1) = 74.
// One signature per NUT-08 blank, in blank order.
const CHANGE_AMOUNTS = [64, 8, 2];

/** NUT-05 quote wire shape (shared by create-quote, melt, and status check). */
function quoteWire(state: "UNPAID" | "PAID", preimage?: string) {
  return {
    quote: "q1",
    request: FIXTURE.invoice,
    amount: 25,
    fee_reserve: 1,
    unit: "sat",
    state,
    expiry: FIXTURE.timestamp + 3600,
    ...(preimage ? { payment_preimage: preimage } : {}),
  };
}

const mockSafeFetch = jest.fn();
const mockFetchCachedEvents = jest.fn();
const mockDeleteCachedEventsByIds = jest.fn();
const mockSignAndPublishEvent = jest.fn();

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
// NOTE: neither @cashu/cashu-ts nor @/utils/cashu/melt-retry-service is
// mocked — the real melt execution path is the point of this suite.
jest.mock("@/utils/db/db-service", () => ({
  fetchCachedEvents: (...args: any[]) => mockFetchCachedEvents(...args),
  deleteCachedEventsByIds: (...args: any[]) =>
    mockDeleteCachedEventsByIds(...args),
}));
// Single-attempt passthrough: retry timing is covered by the fault suite;
// here one attempt keeps the failure paths deterministic and fast.
jest.mock("@/utils/cashu/mint-retry-service", () => ({
  withMintRetry: (fn: any) => fn(),
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
        payTo: "03e7156ae33b0a208d0744199163177e909e80176e55d97a2f221ede0f934dd9ad",
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

/** Verify a proof (from JSON, C as hex) against the mint's private key. */
function proofVerifies(p: { amount: unknown; secret: string; C: string }) {
  const priv = MINT_KEYS.privKeys[String(Number(p.amount))];
  if (!priv) return false;
  return verifyUnblindedSignature(
    {
      secret: new TextEncoder().encode(p.secret),
      C: pointFromHex(p.C),
    } as any,
    priv
  );
}

type MeltMode = "success" | "http500" | "tampered-dleq";
let meltMode: MeltMode;
let checkState: "PAID" | "UNPAID";
let meltRequestBody: string | undefined;

/**
 * The stub mint's melt execution. Hard-THROWS on any request-shape drift so
 * an SDK upgrade that renames quote/inputs/outputs (or drops fields from the
 * proof/blank serialization) fails this suite with a precise message.
 */
function handleMelt(initBody: string) {
  if (meltMode === "http500") {
    return fakeResponse(500, JSON.stringify({ detail: "mint exploded" }));
  }
  const body = JSONInt.parse(initBody) as any;
  meltRequestBody = initBody;

  if (body?.quote !== "q1") {
    throw new Error(
      `melt request drift: expected quote id "q1", got ${JSON.stringify(body?.quote)}`
    );
  }
  if (!Array.isArray(body?.inputs) || body.inputs.length !== WALLET_PROOFS.length) {
    throw new Error("melt request drift: inputs missing or wrong length");
  }
  for (const p of body.inputs) {
    if (
      typeof p?.id !== "string" ||
      typeof p?.secret !== "string" ||
      typeof p?.C !== "string"
    ) {
      throw new Error("melt request drift: input proof lost id/secret/C fields");
    }
    if (p.id !== KEYSET_ID) {
      throw new Error(`melt request drift: input keyset id ${p.id}`);
    }
    if (!proofVerifies(p)) {
      throw new Error(
        `mint stub rejected input proof (amount ${p.amount}): bad signature`
      );
    }
  }
  if (
    !Array.isArray(body?.outputs) ||
    body.outputs.length < CHANGE_AMOUNTS.length
  ) {
    throw new Error(
      "melt request drift: missing NUT-08 change blanks in outputs"
    );
  }

  const change = CHANGE_AMOUNTS.map((amount, i) => {
    const blank = body.outputs[i];
    if (typeof blank?.B_ !== "string" || blank?.id !== KEYSET_ID) {
      throw new Error("melt request drift: change blank lost B_/id fields");
    }
    const B = pointFromHex(blank.B_);
    const priv = MINT_KEYS.privKeys[String(amount)];
    if (!priv) throw new Error(`no mint key for change amount ${amount}`);
    const signed = createBlindSignature(B, priv, KEYSET_ID);
    const dleq = createDLEQProof(B, priv);
    let s = bytesToHex(dleq.s);
    if (meltMode === "tampered-dleq" && i === 0) {
      // Corrupt one DLEQ proof: the SDK must refuse the change outright,
      // never return unverifiable "proofs" as if they were spendable.
      s = (s[0] === "0" ? "1" : "0") + s.slice(1);
    }
    return {
      amount,
      id: KEYSET_ID,
      C_: signed.C_.toHex(true),
      dleq: { e: bytesToHex(dleq.e), s },
    };
  });

  return fakeResponse(
    200,
    JSON.stringify({ ...quoteWire("PAID", PREIMAGE), change })
  );
}

describe("x402 melt execution — real SDK, real safeMeltProofs", () => {
  let nowSpy: jest.SpyInstance;
  let merchantCalls: number;

  beforeEach(() => {
    // mockReset, not clearAllMocks: keep the once-queue clean between tests.
    for (const m of [
      mockSafeFetch,
      mockFetchCachedEvents,
      mockDeleteCachedEventsByIds,
      mockSignAndPublishEvent,
    ]) {
      m.mockReset();
    }
    // The fixture invoice is real but time-bound; pin the clock inside its
    // validity window.
    nowSpy = jest.spyOn(Date, "now").mockReturnValue(FIXTURE.timestamp * 1000);
    merchantCalls = 0;
    meltMode = "success";
    checkState = "UNPAID";
    meltRequestBody = undefined;

    mockSignAndPublishEvent.mockResolvedValue({ id: "newevt" });
    mockDeleteCachedEventsByIds.mockResolvedValue(undefined);

    // One dispatcher for BOTH legs of network traffic: the x402 merchant
    // fetches and the SDK's mint protocol calls (via the guarded transport).
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
                { id: KEYSET_ID, unit: "sat", active: true, input_fee_ppk: 0 },
              ],
            })
          );
        }
        if (path === "/v1/keys" || path.startsWith("/v1/keys/")) {
          return fakeResponse(
            200,
            JSON.stringify({
              keysets: [{ id: KEYSET_ID, unit: "sat", keys: PUB_KEYS }],
            })
          );
        }
        if (path.startsWith("/v1/melt/quote/bolt11/")) {
          // NUT-05 quote-status check — safeMeltProofs' post-failure
          // truth-of-the-world fallback.
          return fakeResponse(
            200,
            JSON.stringify(
              quoteWire(
                checkState,
                checkState === "PAID" ? FALLBACK_PREIMAGE : undefined
              )
            )
          );
        }
        if (path === "/v1/melt/quote/bolt11") {
          return fakeResponse(200, JSON.stringify(quoteWire("UNPAID")));
        }
        if (path === "/v1/melt/bolt11") {
          return handleMelt(init?.body);
        }
      }
      throw new Error(`unexpected fetch in melt-exec SDK test: ${url}`);
    });
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  /** The same construction the tool performs, with drift-precise asserts. */
  async function realWalletAndQuote() {
    const wallet = new Wallet(
      new Mint(MINT_URL, {
        customRequest: createGuardedMintRequest({
          JSONInt,
          HttpResponseError,
          MintOperationError,
        }),
      })
    );
    // Assert the exact SDK surface x402-tools + safeMeltProofs call, so an
    // SDK rename fails here with a precise message, not a generic tool error.
    expect(typeof wallet.loadMint).toBe("function");
    expect(typeof wallet.createMeltQuoteBolt11).toBe("function");
    expect(typeof wallet.meltProofsBolt11).toBe("function");
    expect(typeof wallet.checkMeltQuoteBolt11).toBe("function");
    await wallet.loadMint();
    const quote = await wallet.createMeltQuoteBolt11(FIXTURE.invoice);
    return { wallet, quote };
  }

  describe("safeMeltProofs over a real Wallet", () => {
    it("executes a real melt: protocol-shaped request, preimage on the melt response, change unblinded and verifiable", async () => {
      const { wallet, quote } = await realWalletAndQuote();
      const outcome = await safeMeltProofs(wallet, quote, WALLET_PROOFS as any);

      expect(outcome.status).toBe("paid");
      expect(outcome.errorMessage).toBeUndefined();
      // Preimage source #1 (the one x402-tools reads first): the melt
      // response's merged quote object.
      expect(outcome.meltResponse).toBeDefined();
      expect(outcome.meltResponse!.quote.state).toBe("PAID");
      expect(outcome.meltResponse!.quote.payment_preimage).toBe(PREIMAGE);

      // Change blanks were signed by the stub mint and unblinded +
      // DLEQ-verified by the real SDK: 74 = 100 in − 25 amount − 1 fee.
      expect(outcome.changeProofs).toHaveLength(CHANGE_AMOUNTS.length);
      let changeTotal = 0;
      outcome.changeProofs.forEach((p, i) => {
        expect(p.amount).toBeInstanceOf(Amount);
        expect(p.amount.toNumber()).toBe(CHANGE_AMOUNTS[i]);
        changeTotal += p.amount.toNumber();
        expect(p.id).toBe(KEYSET_ID);
        expect(p.C).toMatch(/^(02|03)[0-9a-f]{64}$/);
        // NUT-12 DLEQ survived unblinding (it was verified inside toProof —
        // the tampered-dleq test below proves that check is load-bearing).
        expect(p.dleq?.s).toMatch(/^[0-9a-f]{64}$/);
        expect(p.dleq?.e).toMatch(/^[0-9a-f]{64}$/);
        expect(p.dleq?.r).toMatch(/^[0-9a-f]{64}$/);
        // Cryptographic proof the unblinding is correct: hash_to_curve(secret)
        // × the mint's private key for this amount equals C.
        expect(proofVerifies(p)).toBe(true);
      });
      expect(changeTotal).toBe(74);

      // The mint saw a protocol-shaped melt request (the stub already threw
      // on drift; these assertions pin the contract precisely).
      expect(typeof meltRequestBody).toBe("string");
      const sent = JSONInt.parse(meltRequestBody as string) as any;
      expect(sent.quote).toBe("q1");
      expect(sent.inputs).toHaveLength(3);
      expect(
        sent.inputs
          .map((p: any) => Number(p.amount))
          .sort((a: number, b: number) => a - b)
      ).toEqual([4, 32, 64]);
      expect(sent.outputs.length).toBeGreaterThanOrEqual(
        CHANGE_AMOUNTS.length
      );
      for (const o of sent.outputs) {
        expect(Number(o.amount)).toBe(0); // NUT-08 blank outputs
        expect(o.B_).toMatch(/^(02|03)[0-9a-f]{64}$/);
        expect(o.id).toBe(KEYSET_ID);
      }
    });

    it("recovers the preimage from the quote-STATUS check when the melt call itself fails", async () => {
      meltMode = "http500";
      checkState = "PAID";
      const { wallet, quote } = await realWalletAndQuote();
      const outcome = await safeMeltProofs(wallet, quote, WALLET_PROOFS as any);

      expect(outcome.status).toBe("paid");
      // No melt response survived — the ONLY preimage source is the quote
      // status check (preimage source #2, the tool's fallback field).
      expect(outcome.meltResponse).toBeUndefined();
      expect(outcome.meltQuote.state).toBe("PAID");
      expect(outcome.meltQuote.payment_preimage).toBe(FALLBACK_PREIMAGE);
      // Change is unrecoverable on this path BY DESIGN: empty changeProofs
      // with a loud diagnostic, never fabricated proofs.
      expect(outcome.changeProofs).toEqual([]);
      expect(outcome.errorMessage).toContain(
        "Original meltProofsBolt11 failed but quote is PAID"
      );
    });

    it("refuses unverifiable change signatures instead of returning fake proofs", async () => {
      meltMode = "tampered-dleq";
      checkState = "UNPAID";
      const { wallet, quote } = await realWalletAndQuote();
      const outcome = await safeMeltProofs(wallet, quote, WALLET_PROOFS as any);

      // The real SDK's DLEQ verification rejected the tampered change
      // signature (MeltChangeError) — if an SDK upgrade dropped that check,
      // this would come back "paid" carrying worthless proofs instead.
      expect(outcome.status).toBe("unpaid");
      expect(outcome.changeProofs).toEqual([]);
      expect(outcome.errorMessage).toContain(
        "change could not be reconstructed"
      );
    });
  });

  describe("pay_x402_request end-to-end with real melt execution", () => {
    /** Wallet event holding the REAL in-test-minted proofs. */
    function walletEvent(id = "old1") {
      return {
        pubkey: PUB,
        id,
        content: JSON.stringify({ mint: MINT_URL, proofs: WALLET_PROOFS }),
      };
    }

    function setupWalletCache(event: any, postDeleteRemaining: any[]) {
      mockFetchCachedEvents
        .mockResolvedValueOnce([event]) // load proofs
        .mockResolvedValueOnce([event, { id: "newevt" }]) // confirm replacement
        .mockResolvedValueOnce(postDeleteRemaining); // deletion postcondition
    }

    it("pays through a real melt and persists cryptographically valid change", async () => {
      setupWalletCache(walletEvent(), [{ id: "newevt" }]);
      const result = await makeHandler()({
        url: MERCHANT_URL,
        method: "GET",
        maxAmountSats: 100,
      });
      const body = JSON.parse(result.content[0].text);

      expect(result.isError).toBe(false);
      expect(body.paid).toBe(true);
      expect(body.acknowledged).toBe(true);
      expect(body.preimage).toBe(PREIMAGE);
      expect(body.amountSats).toBe(25);
      expect(body.feeSats).toBe(1);

      // Wallet accounting persisted the REAL unblinded change proofs: the
      // replacement kind-7375 event must carry exactly the change the stub
      // mint signed, each proof still verifiable against the mint keys.
      const published = mockSignAndPublishEvent.mock.calls[0]?.[1];
      expect(published).toBeDefined();
      const content = JSON.parse(published.content);
      expect(content.mint).toBe(MINT_URL);
      expect(content.del).toEqual(["old1"]);
      expect(content.proofs).toHaveLength(CHANGE_AMOUNTS.length);
      let changeTotal = 0;
      for (const p of content.proofs) {
        changeTotal += Number(p.amount); // Amount serializes as a string
        expect(p.dleq?.r).toMatch(/^[0-9a-f]{64}$/);
        expect(proofVerifies(p)).toBe(true);
      }
      expect(changeTotal).toBe(74);
      expect(mockDeleteCachedEventsByIds).toHaveBeenCalledWith(["old1"]);
    });

    it("falls back to the quote-status preimage when the melt call fails after paying", async () => {
      meltMode = "http500";
      checkState = "PAID";
      setupWalletCache(walletEvent(), [{ id: "newevt" }]);
      const result = await makeHandler()({
        url: MERCHANT_URL,
        method: "GET",
        maxAmountSats: 100,
      });
      const body = JSON.parse(result.content[0].text);

      expect(result.isError).toBe(false);
      expect(body.paid).toBe(true);
      expect(body.acknowledged).toBe(true);
      // The DISTINCT fallback preimage proves the tool read
      // meltOutcome.meltQuote.payment_preimage (quote-status fallback), not
      // the absent melt response.
      expect(body.preimage).toBe(FALLBACK_PREIMAGE);

      // Change is unrecoverable on the fallback path: the replacement event
      // holds no proofs rather than fabricated ones.
      const published = mockSignAndPublishEvent.mock.calls[0]?.[1];
      const content = JSON.parse(published.content);
      expect(content.proofs).toEqual([]);
      expect(content.del).toEqual(["old1"]);
    });
  });
});
