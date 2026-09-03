/**
 * @jest-environment node
 */

// Real-mint contract test for restoreTokensFromProofEvents ("restore wallet
// from nostr backup").
//
// WHY THIS EXISTS
// The restore path rebuilds localStorage["tokens"] from kind:7375 proof
// events — an append-only log in which many proofs are already SPENT — and
// decides which are still spendable via filterUnspentProofs/checkProofsStates.
// Every other test of that logic mocks the cashu library, so a cashu-ts API
// drift (e.g. a changed proof-state response shape) would be invisible until
// a real restore either re-introduced spent proofs as phantom balance or
// silently skipped good funds. This file exercises the REAL @cashu/cashu-ts
// against the staging fake mint (Staging Cashu Mint workflow, port 3338) and
// asserts only mint-confirmed UNSPENT proofs land in the wallet, plus the
// fail-closed skip when a mint is unreachable mid-restore.
// (Sibling: fetch-service-real-mint.test.ts covers the boot-time deletion
// sweep, the other destructive consumer of mint proof states.)
//
// GATED: the mint-dependent tests skip (with a loud warning) when the staging
// mint is unreachable. Point STAGING_CASHU_MINT_URL at another mint to run
// elsewhere. The unreachable-mint fail-closed test runs unconditionally.

import {
  Mint as CashuMint,
  Wallet as CashuWallet,
  Proof,
} from "@cashu/cashu-ts";
import { restoreTokensFromProofEvents } from "@/utils/cashu/wallet-mint-sync";

jest.setTimeout(120000);

const STAGING_MINT_URL =
  process.env.STAGING_CASHU_MINT_URL ?? "http://127.0.0.1:3338";
const UNREACHABLE_MINT_URL = "http://127.0.0.1:39999";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const probeMint = async (): Promise<boolean> => {
  try {
    const res = await fetch(`${STAGING_MINT_URL}/v1/info`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
};

// Mints `amount` sats from the staging FakeWallet mint. FakeWallet settles
// mint quotes immediately; poll briefly to absorb any latency.
const mintProofs = async (
  wallet: CashuWallet,
  amount: number
): Promise<Proof[]> => {
  const quote = await wallet.createMintQuoteBolt11(amount);
  let state: string | undefined;
  for (let i = 0; i < 40; i++) {
    const checked = await wallet.checkMintQuoteBolt11(quote.quote);
    state = typeof checked === "string" ? checked : checked?.state;
    if (state === "PAID" || state === "ISSUED") break;
    await sleep(250);
  }
  if (state !== "PAID" && state !== "ISSUED") {
    throw new Error(`Staging mint quote never settled (state=${state})`);
  }
  return wallet.mintProofsBolt11(amount, quote.quote);
};

// Restore serializes proofs into localStorage, so strip any cashu-ts class
// instances down to the plain wire shape the kind:7375 events carry. The wire
// amount is a plain number; cast narrowly here since cashu-ts types
// Proof.amount as the branded Amount.
const toWireProof = (p: Proof): Proof =>
  ({
    id: p.id,
    amount: Number(p.amount),
    secret: p.secret,
    C: p.C,
  }) as unknown as Proof;

// restoreTokensFromProofEvents is browser-only (early-returns when
// `window` is undefined) and persists via localStorage, so stub both. The
// module's Web Locks guard falls back to inline execution when
// navigator.locks is absent (node), which is what we want here.
const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  },
});
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { dispatchEvent: () => true },
});

const storedTokenSecrets = (): string[] =>
  (JSON.parse(store.get("tokens") ?? "[]") as Proof[]).map((p) => p.secret);

describe("restoreTokensFromProofEvents against the staging mint", () => {
  let mintAvailable = false;
  let spentProofs: Proof[] = [];
  let unspentProofs: Proof[] = [];

  beforeAll(async () => {
    mintAvailable = await probeMint();
    if (!mintAvailable) {
      console.warn(
        `[wallet-mint-sync-restore-real-mint] staging mint unreachable at ${STAGING_MINT_URL}; ` +
          "skipping real-mint tests (start the Staging Cashu Mint workflow to run them)"
      );
      return;
    }
    const wallet = new CashuWallet(new CashuMint(STAGING_MINT_URL));
    await wallet.loadMint();

    // Batch A: minted and then spent in full via a swap, so the mint reports
    // every proof in it SPENT. NOTE: cashu-ts v4 send() short-circuits when
    // the amount exactly matches the inputs (no swap, proofs stay UNSPENT),
    // so send a partial amount to force a real swap that spends the inputs.
    spentProofs = await mintProofs(wallet, 4);
    const spentTotal = spentProofs.reduce(
      (sum, p) => sum + Number(p.amount),
      0
    );
    await wallet.send(spentTotal - 1, spentProofs);

    // Batch B: minted and left untouched — the mint must report UNSPENT.
    unspentProofs = await mintProofs(wallet, 3);

    // Fixture sanity check through the real library: if the mint's state
    // response doesn't line up with what we did, the restore assertions below
    // would be meaningless.
    const perProofSpent = await wallet.checkProofsStates(spentProofs);
    const perProofUnspent = await wallet.checkProofsStates(unspentProofs);
    expect(perProofSpent.every((s) => s.state === "SPENT")).toBe(true);
    expect(perProofUnspent.every((s) => s.state === "UNSPENT")).toBe(true);
  });

  beforeEach(() => store.clear());

  it("restores only mint-confirmed UNSPENT proofs from a spent+unspent backup", async () => {
    if (!mintAvailable) return;

    const result = await restoreTokensFromProofEvents([
      { mint: STAGING_MINT_URL, proofs: spentProofs.map(toWireProof) },
      { mint: STAGING_MINT_URL, proofs: unspentProofs.map(toWireProof) },
      // A mixed event: both proofs are already candidates above, so this also
      // exercises the by-secret dedupe across events.
      {
        mint: STAGING_MINT_URL,
        proofs: [toWireProof(spentProofs[0]!), toWireProof(unspentProofs[0]!)],
      },
    ]);

    expect(result.skippedCount).toBe(0);
    expect(result.skippedMints).toEqual([]);
    expect(result.restoredCount).toBe(unspentProofs.length);
    expect(result.restoredSats).toBe(
      unspentProofs.reduce((sum, p) => sum + Number(p.amount), 0)
    );
    expect(result.mints).toContain(STAGING_MINT_URL);

    // Only the UNSPENT proofs land in the wallet — a cashu-ts response-shape
    // drift that flipped spent detection would resurrect phantom balance here.
    expect(storedTokenSecrets().sort()).toEqual(
      unspentProofs.map((p) => p.secret).sort()
    );
  });

  it("restores reachable-mint proofs while skipping an unreachable mint's", async () => {
    if (!mintAvailable) return;

    const unreachableProof = {
      ...toWireProof(unspentProofs[0]!),
      secret: `unreachable-mint-${"ab".repeat(16)}`,
    };

    const result = await restoreTokensFromProofEvents([
      { mint: STAGING_MINT_URL, proofs: unspentProofs.map(toWireProof) },
      { mint: UNREACHABLE_MINT_URL, proofs: [unreachableProof] },
    ]);

    // The good mint's proofs restore normally; the unreachable mint's proof
    // is reported skipped, NOT restored (fail-closed — no phantom balance
    // from a mint whose state we couldn't verify).
    expect(result.restoredCount).toBe(unspentProofs.length);
    expect(result.skippedCount).toBe(1);
    expect(result.skippedMints).toEqual([UNREACHABLE_MINT_URL]);
    expect(storedTokenSecrets().sort()).toEqual(
      unspentProofs.map((p) => p.secret).sort()
    );
    expect(result.mints).not.toContain(UNREACHABLE_MINT_URL);
  });

  it("reports skippedCount and restores nothing when the mint is unreachable", async () => {
    // Not gated on mintAvailable: this exercises the fail-closed path against
    // a real connection refusal and needs no mint fixtures.
    const fakeProof = (nonce: string): Proof =>
      ({
        id: "009a1f293253e41e",
        amount: 100,
        secret: `unreachable-only-${nonce}`,
        C: "02" + "cd".repeat(32),
      }) as unknown as Proof;

    const result = await restoreTokensFromProofEvents([
      {
        mint: UNREACHABLE_MINT_URL,
        proofs: [fakeProof("aa".repeat(16)), fakeProof("bb".repeat(16))],
      },
    ]);

    expect(result.restoredCount).toBe(0);
    expect(result.restoredSats).toBe(0);
    expect(result.skippedCount).toBe(2);
    expect(result.skippedMints).toEqual([UNREACHABLE_MINT_URL]);
    expect(JSON.parse(store.get("tokens") ?? "[]")).toEqual([]);
  });
});
