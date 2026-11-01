/** @jest-environment node */

// Behavioral tests for the mobile Cashu PoS fallback. @cashu/cashu-ts is
// mocked at the module boundary; the web-side cashu-api-contract test guards
// the method names used here against SDK upgrades (same pinned version).

const asyncStorageStore = new Map<string, string>();

jest.mock(
  "@react-native-async-storage/async-storage",
  () => ({
    getItem: jest.fn(async (key: string) => asyncStorageStore.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      asyncStorageStore.set(key, value);
    }),
    removeItem: jest.fn(async (key: string) => {
      asyncStorageStore.delete(key);
    }),
  }),
  { virtual: true }
);

const callOrder: string[] = [];
const walletBehavior = {
  quoteState: "UNPAID" as string,
  quoteInvoice: "lnbcrt420n1test",
  quoteId: "quote-abc",
  mintedProofs: [
    // v4 decodes proof amounts as Amount instances that JSON-serialize as
    // strings — the claim path must coerce them to plain numbers.
    { amount: { toString: () => "21", toJSON: () => "21" }, id: "ks1", secret: "s1", C: "c1" },
    { amount: { toString: () => "21", toJSON: () => "21" }, id: "ks1", secret: "s2", C: "c2" },
  ],
};

jest.mock("@cashu/cashu-ts", () => ({
  Mint: jest.fn().mockImplementation((url: string) => ({ url })),
  Amount: { from: (value: number) => value },
  Wallet: jest.fn().mockImplementation(() => ({
    loadMint: jest.fn(async () => {
      callOrder.push("loadMint");
    }),
    createMintQuoteBolt11: jest.fn(async (amount: number, _desc: string) => {
      callOrder.push(`createMintQuoteBolt11:${amount}`);
      return {
        quote: walletBehavior.quoteId,
        request: walletBehavior.quoteInvoice,
      };
    }),
    checkMintQuoteBolt11: jest.fn(async (quoteId: string) => {
      callOrder.push(`checkMintQuoteBolt11:${quoteId}`);
      return { quote: quoteId, state: walletBehavior.quoteState };
    }),
    mintProofsBolt11: jest.fn(async (amount: number, quoteId: string) => {
      callOrder.push(`mintProofsBolt11:${amount}:${quoteId}`);
      return walletBehavior.mintedProofs;
    }),
  })),
  getEncodedToken: jest.fn(
    (args: { mint: string; proofs: unknown[]; unit: string }) =>
      `cashuA:${args.mint}:${args.proofs.length}:${args.unit}`
  ),
}), { virtual: true });

import {
  checkCashuQuotePaid,
  claimCashuQuote,
  createCashuMintInvoice,
  exportCashuPosToken,
  getCashuPosBalances,
  recordPendingCashuQuote,
  sweepPendingCashuQuotes,
} from "@/apps/mobile/lib/pos-cashu";

const PUBKEY = "a".repeat(64);
const MINT = "https://mint.example";
const WALLET_KEY = `self-sown:cashu-pos:wallet:${PUBKEY}`;
const PENDING_KEY = `self-sown:cashu-pos:pending-quotes:${PUBKEY}`;

beforeEach(() => {
  asyncStorageStore.clear();
  callOrder.length = 0;
  walletBehavior.quoteState = "UNPAID";
  jest.clearAllMocks();
});

describe("createCashuMintInvoice", () => {
  it("loads the mint before creating the quote", async () => {
    const invoice = await createCashuMintInvoice(MINT, 42, "PoS sale");
    expect(invoice).toEqual({
      invoice: "lnbcrt420n1test",
      quoteId: "quote-abc",
    });
    // cashu-ts v4 throws "Mint info not initialized" without loadMint first.
    expect(callOrder).toEqual(["loadMint", "createMintQuoteBolt11:42"]);
  });
});

describe("checkCashuQuotePaid", () => {
  it.each([
    ["PAID", true],
    ["ISSUED", true],
    ["UNPAID", false],
    ["PENDING", false],
  ])("state %s -> %s", async (state, expected) => {
    walletBehavior.quoteState = state;
    expect(await checkCashuQuotePaid(MINT, "quote-abc")).toBe(expected);
  });
});

describe("claimCashuQuote", () => {
  const pending = {
    mintUrl: MINT,
    quoteId: "quote-abc",
    amountSats: 42,
    createdAt: Date.now(),
  };

  it("claims with the exact quote amount and normalizes Amount-like values", async () => {
    await recordPendingCashuQuote(PUBKEY, pending);
    const claimed = await claimCashuQuote(PUBKEY, pending);

    expect(claimed).toBe(42);
    expect(callOrder).toContain("mintProofsBolt11:42:quote-abc");

    const wallet = JSON.parse(asyncStorageStore.get(WALLET_KEY)!) as Record<
      string,
      Array<{ amount: unknown }>
    >;
    expect(wallet[MINT]).toHaveLength(2);
    for (const proof of wallet[MINT]!) {
      expect(typeof proof.amount).toBe("number");
    }
    // Claimed quote leaves the pending list.
    expect(asyncStorageStore.get(PENDING_KEY)).toBeUndefined();
  });

  it("dedupes proofs already in the wallet", async () => {
    await recordPendingCashuQuote(PUBKEY, pending);
    await claimCashuQuote(PUBKEY, pending);
    await recordPendingCashuQuote(PUBKEY, pending);
    await claimCashuQuote(PUBKEY, pending);
    const wallet = JSON.parse(asyncStorageStore.get(WALLET_KEY)!) as Record<
      string,
      unknown[]
    >;
    expect(wallet[MINT]).toHaveLength(2);
  });
});

describe("sweepPendingCashuQuotes", () => {
  it("claims paid quotes, keeps recent unpaid, drops expired", async () => {
    const now = Date.now();
    await recordPendingCashuQuote(PUBKEY, {
      mintUrl: MINT,
      quoteId: "paid-quote",
      amountSats: 42,
      createdAt: now,
    });
    await recordPendingCashuQuote(PUBKEY, {
      mintUrl: MINT,
      quoteId: "unpaid-quote",
      amountSats: 10,
      createdAt: now,
    });
    await recordPendingCashuQuote(PUBKEY, {
      mintUrl: MINT,
      quoteId: "expired-quote",
      amountSats: 5,
      createdAt: now - 49 * 60 * 60 * 1000,
    });

    // Only the first quote reads as paid; the check mock is per-quoteId.
    const cashu = jest.requireMock("@cashu/cashu-ts") as {
      Wallet: jest.Mock;
    };
    cashu.Wallet.mockImplementation(() => ({
      loadMint: jest.fn(async () => {}),
      checkMintQuoteBolt11: jest.fn(async (quoteId: string) => ({
        quote: quoteId,
        state: quoteId === "paid-quote" ? "PAID" : "UNPAID",
      })),
      mintProofsBolt11: jest.fn(async () => walletBehavior.mintedProofs),
    }));

    const claimed = await sweepPendingCashuQuotes(PUBKEY);
    expect(claimed).toBe(1);

    const remaining = JSON.parse(
      asyncStorageStore.get(PENDING_KEY)!
    ) as Array<{ quoteId: string }>;
    expect(remaining.map((entry) => entry.quoteId)).toEqual(["unpaid-quote"]);

    const balances = await getCashuPosBalances(PUBKEY);
    expect(balances[MINT]).toBe(42);
  });

  it("returns 0 with no pending quotes", async () => {
    expect(await sweepPendingCashuQuotes(PUBKEY)).toBe(0);
  });
});

describe("exportCashuPosToken", () => {
  it("encodes the full balance and clears it locally", async () => {
    await recordPendingCashuQuote(PUBKEY, {
      mintUrl: MINT,
      quoteId: "quote-abc",
      amountSats: 42,
      createdAt: Date.now(),
    });
    await claimCashuQuote(PUBKEY, {
      mintUrl: MINT,
      quoteId: "quote-abc",
      amountSats: 42,
      createdAt: Date.now(),
    });

    const token = await exportCashuPosToken(PUBKEY, MINT);
    expect(token).toBe(`cashuA:${MINT}:2:sat`);
    expect(await getCashuPosBalances(PUBKEY)).toEqual({});
  });

  it("refuses to export an empty balance", async () => {
    await expect(exportCashuPosToken(PUBKEY, MINT)).rejects.toThrow(
      "No ecash balance"
    );
  });
});
