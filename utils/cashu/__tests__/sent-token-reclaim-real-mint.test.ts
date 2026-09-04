/**
 * @jest-environment node
 */

// Real-mint contract test for the Sent Tokens "Check & Reclaim" path
// (components/wallet/sent-tokens.tsx handleCheck).
//
// WHY THIS EXISTS
// cashu-ts v4 enforces two things only at runtime, invisible to the
// component's mocked suite: getDecodedToken(token, []) throws "short keyset
// id" on v2 keyset IDs (Nutshell >= 0.20), and wallet.receive() rejects a
// token object whose `unit` is absent ("Token is not in wallet unit").
// Reclaim shipped with BOTH bugs and failed against every real mint. This
// file drives the real library against the staging FakeWallet mint (Staging
// Cashu Mint workflow, port 3338) using the exact decode/receive call
// shapes the component uses, and pins the unit-less failure mode so a
// regression here fails loudly instead of stranding users' funds.
//
// GATED: skipped (with a loud warning) when the staging mint is unreachable.
// Point STAGING_CASHU_MINT_URL at another mint to run elsewhere.

import {
  Mint as CashuMint,
  Wallet as CashuWallet,
  getEncodedToken,
  Proof,
} from "@cashu/cashu-ts";
import { decodeEscrowLockedProofs } from "../escrow-checkout";

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

describe("sent-token reclaim against the staging mint", () => {
  let mintAvailable = false;

  beforeAll(async () => {
    mintAvailable = await probeMint();
    if (!mintAvailable) {
      console.warn(
        `[sent-token-reclaim-real-mint] staging mint unreachable at ${STAGING_MINT_URL}; ` +
          "skipping real-mint tests (start the Staging Cashu Mint workflow to run them)"
      );
    }
  });

  test("reclaims a Send-encoded token: keyset-aware decode + unit-threaded receive", async () => {
    if (!mintAvailable) return;
    const sendWallet = new CashuWallet(new CashuMint(STAGING_MINT_URL));
    await sendWallet.loadMint();
    const sendProofs = await mintProofs(sendWallet, 8);
    const sendTotal = sendProofs.reduce((sum, p) => sum + Number(p.amount), 0);

    // EXACTLY the Send button's encoding (send-button.tsx): no unit field —
    // the decoder must supply the default so receive() accepts the token.
    const token = getEncodedToken({
      mint: STAGING_MINT_URL,
      proofs: sendProofs,
    });

    // The component's decode: tolerates v2 keyset IDs via a keyset fetch.
    const decoded = await decodeEscrowLockedProofs(token, STAGING_MINT_URL);
    expect(decoded.unit).toBeDefined();

    // The component's reclaim swap: fresh secrets from the mint.
    const reclaimWallet = new CashuWallet(new CashuMint(decoded.mint));
    await reclaimWallet.loadMint();
    const received = await reclaimWallet.receive({
      mint: decoded.mint,
      proofs: decoded.proofs,
      unit: decoded.unit,
    });
    expect(received.reduce((sum, p) => sum + Number(p.amount), 0)).toBe(
      sendTotal
    );

    // The swap spent the original proofs — a leftover copy of the token can
    // no longer race the user for the funds.
    const states = await reclaimWallet.checkProofsStates(decoded.proofs);
    expect(states.every((s) => s.state === "SPENT")).toBe(true);
  });

  test("pins the v4 failure mode the fix guards against: receive without unit is rejected", async () => {
    if (!mintAvailable) return;
    const wallet = new CashuWallet(new CashuMint(STAGING_MINT_URL));
    await wallet.loadMint();
    const proofs = await mintProofs(wallet, 4);
    // If a future cashu-ts stops enforcing unit, this fails loudly — revisit
    // whether reclaim still needs the threaded unit.
    await expect(
      wallet.receive({ mint: STAGING_MINT_URL, proofs })
    ).rejects.toThrow(/unit/i);
    // Rejected client-side BEFORE the swap: the proofs were never spent.
    const states = await wallet.checkProofsStates(proofs);
    expect(states.every((s) => s.state === "UNSPENT")).toBe(true);
  });
});
