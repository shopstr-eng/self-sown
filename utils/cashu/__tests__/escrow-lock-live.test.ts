/**
 * @jest-environment node
 */

// Real-mint contract test for the escrow lock flow (task: prove a payment
// can't strand buyer funds).
//
// WHY THIS EXISTS
// The escrow checkout lock path (product-invoice-card / cart-invoice-card →
// safeSwap with buildEscrowLockOutputConfig) is otherwise only exercised with
// mocked wallets, which stay green when @cashu/cashu-ts or mint behavior
// drifts. This suite runs the REAL flow against the staging FakeWallet mint
// (Staging Cashu Mint workflow, port 3338): lock swap → decode the locked
// token and verify the P2PK tags (data=seller, locktime, refund=buyer) →
// stripEscrowLockedProofs keeps locked proofs out of localStorage["tokens"]
// → the mint rejects an unsigned spend → buyer refunds after expiry → seller
// claims before expiry.
//
// GATED: skips with a loud warning when the staging mint is unreachable.
// Point STAGING_CASHU_MINT_URL at another mint to run elsewhere.
// (Sibling: wallet-mint-sync-restore-real-mint.test.ts.)

import {
  Mint as CashuMint,
  Wallet as CashuWallet,
  Proof,
  getEncodedToken,
} from "@cashu/cashu-ts";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import {
  buildEscrowLockOutputConfig,
  decodeEscrowLockedProofs,
  recordBuyerEscrow,
  signEscrowLockedProofs,
  stripEscrowLockedProofs,
} from "@/utils/cashu/escrow-checkout";
import { normalizeP2PKPubkey } from "@/utils/cashu/escrow-payout";
import { safeSwap } from "@/utils/cashu/swap-retry-service";

jest.setTimeout(120000);

const STAGING_MINT_URL =
  process.env.STAGING_CASHU_MINT_URL ?? "http://127.0.0.1:3338";

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

// recordBuyerEscrow / stripEscrowLockedProofs persist via localStorage, so
// stub it (same pattern as the sibling real-mint suite).
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

function parseP2PKSecret(proof: Proof): { data: string; tags: string[][] } {
  const [kind, payload] = JSON.parse(proof.secret) as [
    string,
    { data: string; tags?: string[][] },
  ];
  expect(kind).toBe("P2PK");
  return { data: payload.data, tags: payload.tags ?? [] };
}

const tagValues = (tags: string[][], name: string) =>
  tags.filter((t) => t[0] === name).map((t) => t.slice(1));

describe("escrow lock flow against the staging mint", () => {
  const sellerSk = generateSecretKey();
  const buyerSk = generateSecretKey();
  const sellerPk = getPublicKey(sellerSk);
  const buyerPk = getPublicKey(buyerSk);
  const signerOf = (sk: Uint8Array) => ({ _getPrivKey: async () => sk });

  const wallet = new CashuWallet(new CashuMint(STAGING_MINT_URL));
  const nowSec = () => Math.floor(Date.now() / 1000);

  // Lock A: future expiry (seller may claim now, buyer refunds later).
  const expiresFuture = nowSec() + 3600;
  // Lock B: already expired (buyer can refund immediately).
  const expiresPast = nowSec() - 120;

  let mintAvailable = false;
  let walletProofs: Proof[] = [];
  let lockedA: Proof[] = [];
  let lockedB: Proof[] = [];
  let tokenA = "";
  let tokenB = "";

  beforeAll(async () => {
    mintAvailable = await probeMint();
    if (!mintAvailable) {
      console.warn(
        `[escrow-lock-live] staging mint unreachable at ${STAGING_MINT_URL}; ` +
          "skipping real-mint tests (start the Staging Cashu Mint workflow to run them)"
      );
      return;
    }
    await wallet.loadMint();
    walletProofs = await mintProofs(wallet, 64);
    expect(walletProofs.reduce((s, p) => s + Number(p.amount), 0)).toBe(64);
  });

  const skipIfNoMint = () => {
    if (!mintAvailable) {
      console.warn("[escrow-lock-live] skipped — staging mint unreachable");
      return true;
    }
    return false;
  };

  it("locks proofs to the seller via buildEscrowLockOutputConfig (future expiry)", async () => {
    if (skipIfNoMint()) return;
    const outcome = await safeSwap(wallet, 8, walletProofs, {
      sendConfig: { includeFees: true },
      outputConfig: buildEscrowLockOutputConfig({
        sellerPubkey: sellerPk,
        buyerPubkey: buyerPk,
        expiresAt: expiresFuture,
      }),
    });
    expect(outcome.status).toBe("swapped");
    lockedA = outcome.send;
    walletProofs = outcome.keep;
    expect(lockedA.reduce((s, p) => s + Number(p.amount), 0)).toBe(8);

    tokenA = getEncodedToken({ mint: STAGING_MINT_URL, proofs: lockedA });
    const { proofs } = await decodeEscrowLockedProofs(tokenA, STAGING_MINT_URL);
    expect(proofs.length).toBe(lockedA.length);
    for (const proof of proofs) {
      const { data, tags } = parseP2PKSecret(proof);
      expect(normalizeP2PKPubkey(data)).toBe(sellerPk);
      expect(tagValues(tags, "locktime")).toEqual([[String(expiresFuture)]]);
      const refund = tagValues(tags, "refund").flat();
      expect(refund.map(normalizeP2PKPubkey)).toContain(buyerPk);
    }
  });

  it("locks a second output with an already-expired locktime", async () => {
    if (skipIfNoMint()) return;
    const outcome = await safeSwap(wallet, 8, walletProofs, {
      sendConfig: { includeFees: true },
      outputConfig: buildEscrowLockOutputConfig({
        sellerPubkey: sellerPk,
        buyerPubkey: buyerPk,
        expiresAt: expiresPast,
      }),
    });
    expect(outcome.status).toBe("swapped");
    lockedB = outcome.send;
    walletProofs = outcome.keep;

    tokenB = getEncodedToken({ mint: STAGING_MINT_URL, proofs: lockedB });
    const { proofs } = await decodeEscrowLockedProofs(tokenB, STAGING_MINT_URL);
    for (const proof of proofs) {
      const { data, tags } = parseP2PKSecret(proof);
      expect(normalizeP2PKPubkey(data)).toBe(sellerPk);
      expect(tagValues(tags, "locktime")).toEqual([[String(expiresPast)]]);
      const refund = tagValues(tags, "refund").flat();
      expect(refund.map(normalizeP2PKPubkey)).toContain(buyerPk);
    }
  });

  it("stripEscrowLockedProofs keeps locked proofs out of the wallet stash", () => {
    if (skipIfNoMint()) return;
    // Record both escrows exactly like product-invoice-card does (the record
    // carries lockedSecrets so the guard never has to decode the token).
    for (const [escrowId, token, locked, expiresAt] of [
      ["escrow-live-a", tokenA, lockedA, expiresFuture],
      ["escrow-live-b", tokenB, lockedB, expiresPast],
    ] as const) {
      const recorded = recordBuyerEscrow({
        escrowId,
        orderId: `order-${escrowId}`,
        sellerPubkey: sellerPk,
        amountSats: 8,
        mintUrl: STAGING_MINT_URL,
        expiresAt,
        createdAt: nowSec(),
        lockedToken: token,
        lockedSecrets: locked.map((p) => p.secret),
      });
      expect(recorded).toBe(true);
    }

    const everything = [...walletProofs, ...lockedA, ...lockedB];
    const stripped = stripEscrowLockedProofs(everything);
    const lockedSecrets = new Set(
      [...lockedA, ...lockedB].map((p) => p.secret)
    );
    expect(stripped.some((p) => lockedSecrets.has(p.secret))).toBe(false);
    expect(stripped.length).toBe(walletProofs.length);

    // End-to-end: the stash the guard produces is what lands in
    // localStorage["tokens"] — locked secrets must be absent there.
    localStorage.setItem(
      "tokens",
      JSON.stringify([{ mint: STAGING_MINT_URL, proofs: stripped }])
    );
    const stash = JSON.parse(localStorage.getItem("tokens")!) as {
      mint: string;
      proofs: Proof[];
    }[];
    const stashedSecrets = stash.flatMap((t) => t.proofs.map((p) => p.secret));
    expect(stashedSecrets.some((s) => lockedSecrets.has(s))).toBe(false);
  });

  it("mint rejects spending locked proofs without the entitled signature", async () => {
    if (skipIfNoMint()) return;
    // NOTE: send a PARTIAL amount — cashu-ts v4 short-circuits send() when
    // the amount exactly matches the inputs (no swap, no mint round-trip),
    // which would vacuously "pass" this test.
    const outcome = await safeSwap(wallet, 7, lockedA);
    expect(outcome.status).not.toBe("swapped");
    // The mint must still consider the locked proofs unspent — the rejection
    // is authorization, not consumption.
    const states = await wallet.checkProofsStates(lockedA);
    expect(states.every((s) => s.state === "UNSPENT")).toBe(true);
  });

  it("buyer refunds the expired lock with their refund key", async () => {
    if (skipIfNoMint()) return;
    const signed = await signEscrowLockedProofs(
      tokenB,
      signerOf(buyerSk),
      STAGING_MINT_URL
    );
    const outcome = await safeSwap(wallet, 7, signed);
    expect(outcome.status).toBe("swapped");
    const refunded = [...outcome.keep, ...outcome.send];
    expect(refunded.reduce((s, p) => s + Number(p.amount), 0)).toBe(8);

    const states = await wallet.checkProofsStates(lockedB);
    expect(states.every((s) => s.state === "SPENT")).toBe(true);
    const newStates = await wallet.checkProofsStates(refunded);
    expect(newStates.every((s) => s.state === "UNSPENT")).toBe(true);
    walletProofs = [...walletProofs, ...refunded];
  });

  it("seller claims the live lock with their key before expiry", async () => {
    if (skipIfNoMint()) return;
    const signed = await signEscrowLockedProofs(
      tokenA,
      signerOf(sellerSk),
      STAGING_MINT_URL
    );
    const outcome = await safeSwap(wallet, 7, signed);
    expect(outcome.status).toBe("swapped");

    const states = await wallet.checkProofsStates(lockedA);
    expect(states.every((s) => s.state === "SPENT")).toBe(true);
  });
});
