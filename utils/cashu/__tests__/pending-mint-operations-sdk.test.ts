/**
 * @jest-environment jsdom
 */
// Regression guard for the RECEIVE/top-up direction (NUT-04 mint quote →
// mint execution → unblinded proofs) against the INSTALLED @cashu/cashu-ts —
// the receive-side complement to the x402 melt-quote / melt-exec SDK suites,
// which guard the pay direction.
//
// The production top-up flow (mint-button claim path + boot-time
// recoverPendingMintQuotes in utils/cashu/pending-mint-operations.ts) is
// otherwise covered only by mocked-wallet tests
// (pending-mint-operations.test.ts) that stay green when the SDK renames
// createMintQuoteBolt11 / checkMintQuoteBolt11 / mintProofsBolt11 or changes
// their request/response field names — exactly the failure mode that would
// silently break agents' ability to fund their wallets.
//
// Here a REAL Wallet runs over the real guarded transport with only
// safeFetch stubbed at the network boundary, serving protocol-shaped
// NUT-04/NUT-06/NUT-12 responses. The stub mint holds locally generated keys
// (createNewMintKeys) and signs the wallet's outputs for real
// (createBlindSignature + createDLEQProof), so blind-signature unblinding
// and DLEQ verification genuinely execute. The stub THROWS on any
// request-shape drift, and the tests assert the response-side contract the
// recovery flow consumes — quote.state, the signatures array, and the
// kind-7375 wallet-event shape handed to onProofsClaimed — so an SDK upgrade
// that renames mint fields fails here, not in live wallet top-ups.

import {
  Amount,
  HttpResponseError,
  JSONInt,
  Mint,
  MintOperationError,
  Wallet,
  createBlindSignature,
  createDLEQProof,
  createNewMintKeys,
  pointFromHex,
  serializeMintKeys,
  verifyUnblindedSignature,
} from "@cashu/cashu-ts";
import {
  getPendingMintQuotes,
  recordPendingMintQuote,
  recoverPendingMintQuotes,
} from "@/utils/cashu/pending-mint-operations";
import { createGuardedMintRequest } from "@/utils/x402/guarded-mint-request";

// Same time-bound 25-sat mainnet invoice as the x402 melt suites. The wallet
// re-decodes the quote's `request` invoice and asserts its amount matches
// `amount` (assertBolt11MintQuoteAmount), so the stub mint must return a
// REAL decodable invoice — a placeholder string fails inside the SDK, not at
// the assertion.
const FIXTURE_INVOICE =
  "lnbc250n1p4ta2gqpp5fwcxlrjw8fm3t5sp64eap2jzxa3w2hdt6cdzcq3837jke3kjjnsqhp5nl3vhw262vvaccprhdszgtjsvfcsjxkwx696y00axeflclqqz08qxqrrsscqpfuv50sphk9dnjypn94zwxapu6w7ren0n30dm36gr5seuqz8786uh5856y9ypr4tadlmgsr5dn2fpymvzuaxvm7jfuum7xm9462zx5hcgqqdxmwz";
const FIXTURE_TIMESTAMP = 1790880000;

const MINT_URL = "https://mint.minibits.cash/Bitcoin";
const MINT_AMOUNT = 25; // splits into 16 + 8 + 1 outputs
const QUOTE_ID = "mq1";

// Locally generated mint keys: the stub mint signs with the private half and
// the real wallet unblinds + DLEQ-verifies against the public half it fetches
// from /v1/keys. Derived at runtime via the SDK's own helpers so this
// plumbing tracks the installed SDK.
const MINT_KEYS = createNewMintKeys(7); // amounts 1..64
const KEYSET_ID = MINT_KEYS.keysetId;
const PUB_KEYS = serializeMintKeys(MINT_KEYS.pubKeys);

// NUT-06 mint info advertising bolt11 MINT support for sat — required by the
// SDK's requireSupport("mint", "bolt11") gate inside createMintQuoteBolt11
// and mintProofsBolt11.
const MINT_INFO = {
  name: "mint-receive regression mint",
  pubkey: PUB_KEYS["1"],
  version: "mint-receive-regression/1.0",
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

/** NUT-04 mint-quote wire shape (shared by create-quote and status check). */
function quoteWire(state: "UNPAID" | "PAID" | "ISSUED") {
  return {
    quote: QUOTE_ID,
    request: FIXTURE_INVOICE,
    amount: MINT_AMOUNT,
    unit: "sat",
    state,
    expiry: FIXTURE_TIMESTAMP + 3600,
  };
}

const mockSafeFetch = jest.fn();

jest.mock("@/utils/url-safety", () => {
  const actual = jest.requireActual("@/utils/url-safety");
  return {
    ...actual,
    safeFetch: (...args: any[]) => mockSafeFetch(...args),
  };
});
// NOTE: @cashu/cashu-ts is deliberately NOT mocked — the real receive path
// is the point of this suite. Single-attempt passthrough for withMintRetry:
// retry timing is covered by mint-retry-service's own suite; here one
// attempt keeps the failure paths deterministic and fast.
jest.mock("@/utils/cashu/mint-retry-service", () => ({
  withMintRetry: (fn: any) => fn(),
}));

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

type MintMode = "success" | "tampered-dleq";
let mintMode: MintMode;
let checkState: "PAID" | "UNPAID";
let createQuoteRequestBody: string | undefined;
let mintRequestBody: string | undefined;
let mintQuoteStatusChecks: number;

/**
 * The stub mint's NUT-04 mint execution. Hard-THROWS on any request-shape
 * drift so an SDK upgrade that renames quote/outputs (or drops fields from
 * the blinded-message serialization) fails this suite with a precise
 * message. Unlike NUT-08 melt change blanks (amount-0), mint outputs carry
 * their REAL amounts — the stub enforces that distinction.
 */
function handleMint(initBody: string) {
  const body = JSONInt.parse(initBody) as any;
  mintRequestBody = initBody;

  if (body?.quote !== QUOTE_ID) {
    throw new Error(
      `mint request drift: expected quote id "${QUOTE_ID}", got ${JSON.stringify(
        body?.quote
      )}`
    );
  }
  if (!Array.isArray(body?.outputs) || body.outputs.length === 0) {
    throw new Error("mint request drift: outputs missing or empty");
  }

  let total = 0;
  const signatures = body.outputs.map((o: any, i: number) => {
    if (typeof o?.B_ !== "string" || o?.id !== KEYSET_ID) {
      throw new Error("mint request drift: output lost B_/id fields");
    }
    const amount = Number(o.amount);
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error(
        `mint request drift: mint output amount must be a positive integer (unlike NUT-08 change blanks), got ${JSON.stringify(
          o.amount
        )}`
      );
    }
    const priv = MINT_KEYS.privKeys[String(amount)];
    if (!priv) throw new Error(`no mint key for output amount ${amount}`);
    total += amount;
    const B = pointFromHex(o.B_);
    const signed = createBlindSignature(B, priv, KEYSET_ID);
    const dleq = createDLEQProof(B, priv);
    let s = bytesToHex(dleq.s);
    if (mintMode === "tampered-dleq" && i === 0) {
      // Corrupt one DLEQ proof: the SDK must refuse the minted proofs
      // outright, never hand unverifiable "proofs" to wallet persistence.
      s = (s[0] === "0" ? "1" : "0") + s.slice(1);
    }
    return {
      amount,
      id: KEYSET_ID,
      C_: signed.C_.toHex(true),
      dleq: { e: bytesToHex(dleq.e), s },
    };
  });
  if (total !== MINT_AMOUNT) {
    throw new Error(
      `mint request drift: outputs total ${total}, expected ${MINT_AMOUNT}`
    );
  }

  return fakeResponse(200, JSON.stringify({ signatures }));
}

/** A real Wallet over the guarded transport, with drift-precise asserts. */
async function realWallet() {
  const wallet = new Wallet(
    new Mint(MINT_URL, {
      customRequest: createGuardedMintRequest({
        JSONInt,
        HttpResponseError,
        MintOperationError,
      }),
    })
  );
  // Assert the exact SDK surface the top-up flow calls, so an SDK rename
  // fails here with a precise message, not a generic recovery error.
  expect(typeof wallet.loadMint).toBe("function");
  expect(typeof wallet.createMintQuoteBolt11).toBe("function");
  expect(typeof wallet.checkMintQuoteBolt11).toBe("function");
  expect(typeof wallet.mintProofsBolt11).toBe("function");
  await wallet.loadMint();
  return wallet;
}

function seedPaidUnclaimedQuote() {
  recordPendingMintQuote({
    quoteId: QUOTE_ID,
    mintUrl: MINT_URL,
    amount: MINT_AMOUNT,
    invoice: FIXTURE_INVOICE,
    status: "paid_unclaimed",
  });
}

describe("pending-mint-operations — real-SDK receive/top-up flow", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mockSafeFetch.mockReset();
    mintMode = "success";
    checkState = "PAID";
    createQuoteRequestBody = undefined;
    mintRequestBody = undefined;
    mintQuoteStatusChecks = 0;

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
              keysets: [{ id: KEYSET_ID, unit: "sat", keys: PUB_KEYS }],
            })
          );
        }
        if (path === `/v1/mint/quote/bolt11/${QUOTE_ID}`) {
          // NUT-04 quote-status check — recovery's truth-of-the-world poll.
          mintQuoteStatusChecks++;
          return fakeResponse(200, JSON.stringify(quoteWire(checkState)));
        }
        if (path === "/v1/mint/quote/bolt11") {
          createQuoteRequestBody = init?.body;
          return fakeResponse(200, JSON.stringify(quoteWire("UNPAID")));
        }
        if (path === "/v1/mint/bolt11") {
          return handleMint(init?.body);
        }
      }
      throw new Error(`unexpected fetch in receive-sdk test: ${url}`);
    });
  });

  it("mints real proofs for a paid quote: protocol-shaped requests, DLEQ-verified proofs, persisted wallet-event shape intact", async () => {
    // Top-up entry point (same call mint-button makes): the quote request
    // and response field names are part of the drift contract.
    const wallet = await realWallet();
    const quote = await wallet.createMintQuoteBolt11(MINT_AMOUNT);
    expect(quote.quote).toBe(QUOTE_ID);
    expect(quote.request).toBe(FIXTURE_INVOICE);
    expect(quote.state).toBe("UNPAID");

    expect(typeof createQuoteRequestBody).toBe("string");
    const createBody = JSONInt.parse(createQuoteRequestBody as string) as any;
    expect(createBody.unit).toBe("sat");
    expect(Number(createBody.amount)).toBe(MINT_AMOUNT);

    // The invoice is "paid" (stub serves PAID on the status check); the
    // boot-time recovery flow claims it through the real SDK.
    seedPaidUnclaimedQuote();
    let claimed: { quote: any; proofs: any[] } | undefined;
    const result = await recoverPendingMintQuotes({
      buildWallet: async () => wallet,
      onProofsClaimed: async (q: any, proofs: any[]) => {
        claimed = { quote: q, proofs };
      },
    });

    expect(result).toMatchObject({
      total: 1,
      recovered: 1,
      failed: 0,
      stillPending: 0,
      abandoned: 0,
    });
    expect(mintQuoteStatusChecks).toBe(1);
    // Claimed → the pending record is gone.
    expect(getPendingMintQuotes()).toHaveLength(0);

    // The mint saw a protocol-shaped mint request (the stub already threw
    // on drift; these assertions pin the contract precisely).
    expect(typeof mintRequestBody).toBe("string");
    const sent = JSONInt.parse(mintRequestBody as string) as any;
    expect(sent.quote).toBe(QUOTE_ID);
    expect(sent.outputs).toHaveLength(3); // 16 + 8 + 1
    let outputTotal = 0;
    for (const o of sent.outputs) {
      const amount = Number(o.amount);
      expect(amount).toBeGreaterThan(0);
      outputTotal += amount;
      expect(o.B_).toMatch(/^(02|03)[0-9a-f]{64}$/);
      expect(o.id).toBe(KEYSET_ID);
    }
    expect(outputTotal).toBe(MINT_AMOUNT);

    // The proofs handed to persistence were signed by the stub mint and
    // unblinded + DLEQ-verified by the real SDK inside toProof — the
    // tampered-dleq test below proves that check is load-bearing.
    expect(claimed).toBeDefined();
    expect(claimed!.quote.quoteId).toBe(QUOTE_ID);
    expect(claimed!.proofs).toHaveLength(3);
    let mintedTotal = 0;
    for (const p of claimed!.proofs) {
      expect(p.amount).toBeInstanceOf(Amount);
      mintedTotal += p.amount.toNumber();
      expect(p.id).toBe(KEYSET_ID);
      expect(typeof p.secret).toBe("string");
      expect(p.C).toMatch(/^(02|03)[0-9a-f]{64}$/);
      expect(p.dleq?.s).toMatch(/^[0-9a-f]{64}$/);
      expect(p.dleq?.e).toMatch(/^[0-9a-f]{64}$/);
      expect(p.dleq?.r).toMatch(/^[0-9a-f]{64}$/);
      // Cryptographic proof the unblinding is correct:
      // hash_to_curve(secret) × the mint's private key for this amount = C.
      expect(proofVerifies(p)).toBe(true);
    }
    expect(mintedTotal).toBe(MINT_AMOUNT);

    // The persisted kind-7375 wallet-event contract: content is
    // {mint, proofs} JSON with each proof carrying id/amount/secret/C —
    // and Amount instances JSON-serialize as STRINGS, which every
    // persistence/ summing consumer must survive (the "0100" concat trap).
    const content = JSON.parse(
      JSON.stringify({ mint: MINT_URL, proofs: claimed!.proofs })
    );
    expect(content.mint).toBe(MINT_URL);
    expect(content.proofs).toHaveLength(3);
    let persistedTotal = 0;
    for (const p of content.proofs) {
      expect(p.id).toBe(KEYSET_ID);
      expect(typeof p.secret).toBe("string");
      expect(p.C).toMatch(/^(02|03)[0-9a-f]{64}$/);
      expect(typeof p.amount).toBe("string");
      persistedTotal += Number(p.amount);
    }
    expect(persistedTotal).toBe(MINT_AMOUNT);
  });

  it("refuses unverifiable minted signatures instead of persisting fake proofs", async () => {
    mintMode = "tampered-dleq";
    seedPaidUnclaimedQuote();
    const onProofsClaimed = jest.fn();

    const result = await recoverPendingMintQuotes({
      buildWallet: realWallet,
      onProofsClaimed,
      logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() } as any,
    });

    // The real SDK's DLEQ verification rejected the tampered mint signature —
    // if an SDK upgrade dropped that check, this would come back recovered:1
    // carrying worthless proofs into the wallet event instead.
    expect(result.recovered).toBe(0);
    expect(result.failed).toBe(1);
    expect(onProofsClaimed).not.toHaveBeenCalled();
    // The pending record is preserved for the next recovery pass.
    const remaining = getPendingMintQuotes();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.quoteId).toBe(QUOTE_ID);
    expect(remaining[0]!.attempts).toBe(1);
  });

  it("leaves an UNPAID quote pending without hitting the mint endpoint", async () => {
    checkState = "UNPAID";
    seedPaidUnclaimedQuote();
    const onProofsClaimed = jest.fn();

    const result = await recoverPendingMintQuotes({
      buildWallet: realWallet,
      onProofsClaimed,
    });

    // Pins the quote-status contract: the SDK must expose the wire `state`
    // field as a string the recovery flow can compare against "UNPAID".
    expect(result.stillPending).toBe(1);
    expect(mintQuoteStatusChecks).toBe(1);
    expect(mintRequestBody).toBeUndefined();
    expect(onProofsClaimed).not.toHaveBeenCalled();
    expect(getPendingMintQuotes()).toHaveLength(1);
  });
});
