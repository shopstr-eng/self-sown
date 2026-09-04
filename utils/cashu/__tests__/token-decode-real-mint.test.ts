/**
 * @jest-environment node
 */

// Real-mint contract test for decodeTokenWithKeysets (utils/cashu/token-decode.ts).
//
// WHY THIS EXISTS
// cashu-ts v4's getDecodedToken(token, []) throws "A short keyset ID v2 was
// encountered" for tokens from mints issuing v2 (0x01-prefixed) keyset IDs —
// Nutshell >= 0.20, including the staging mint. Every receive/redeem/claim
// path routes through decodeTokenWithKeysets, which must (a) fetch the mint's
// /v1/keysets and retry and (b) when the caller can't supply the mint, read
// it from the token envelope via getTokenMetadata. Mocked tests can never see
// either behavior (a mocked getDecodedToken doesn't throw the keyset error).
//
// GATED: skipped (with a loud warning) when the staging mint is unreachable.
// Point STAGING_CASHU_MINT_URL at another mint to run elsewhere.

import {
  Mint as CashuMint,
  Wallet as CashuWallet,
  getEncodedToken,
  getDecodedToken,
  Proof,
} from "@cashu/cashu-ts";
import { decodeTokenWithKeysets } from "../token-decode";

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

describe("decodeTokenWithKeysets against the staging mint (v2 keysets)", () => {
  let mintAvailable = false;
  let token = "";
  let fullKeysetId = "";

  beforeAll(async () => {
    mintAvailable = await probeMint();
    if (!mintAvailable) {
      console.warn(
        `[token-decode-real-mint] staging mint unreachable at ${STAGING_MINT_URL}; ` +
          "skipping real-mint tests (start the Staging Cashu Mint workflow to run them)"
      );
      return;
    }
    const wallet = new CashuWallet(new CashuMint(STAGING_MINT_URL));
    await wallet.loadMint();
    const proofs = await mintProofs(wallet, 4);
    token = getEncodedToken({ mint: STAGING_MINT_URL, proofs, unit: "sat" });
    const keysetsRes = await fetch(`${STAGING_MINT_URL}/v1/keysets`);
    fullKeysetId = (await keysetsRes.json()).keysets[0].id;
    // Fixture sanity: this mint must issue v2 keyset IDs or the test is
    // vacuous (the plain decode would succeed and prove nothing).
    expect(fullKeysetId.startsWith("01")).toBe(true);
  });

  test("pins the failure mode: plain decode throws the short-keyset-id error", () => {
    if (!mintAvailable) return;
    expect(() => getDecodedToken(token, [])).toThrow(/short keyset id/i);
  });

  test("decodes when the caller supplies the mint URL", async () => {
    if (!mintAvailable) return;
    const decoded = await decodeTokenWithKeysets(token, STAGING_MINT_URL);
    expect(decoded.mint).toBe(STAGING_MINT_URL);
    expect(decoded.proofs.length).toBeGreaterThan(0);
    // The v2 keyset ID was mapped through the mint's keyset list.
    expect(decoded.proofs[0].id).toBe(fullKeysetId);
  });

  test("decodes WITHOUT a caller-supplied mint by reading the token envelope", async () => {
    if (!mintAvailable) return;
    const decoded = await decodeTokenWithKeysets(token);
    expect(decoded.mint).toBe(STAGING_MINT_URL);
    expect(decoded.proofs[0].id).toBe(fullKeysetId);
  });

  test("rethrows non-keyset decode errors unchanged", async () => {
    if (!mintAvailable) return;
    await expect(decodeTokenWithKeysets("cashuB_garbage")).rejects.toThrow();
    await expect(decodeTokenWithKeysets("not-a-token")).rejects.toThrow();
  });
});
