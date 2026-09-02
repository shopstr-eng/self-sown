/**
 * Throwaway staging probe against https://testnut.cashu.space:
 * 1. mint quote becomes PAID without real Lightning (fake wallet)
 * 2. mint proofs
 * 3. swap into the escrow P2PK lock (seller key, locktime, refund=buyer,
 *    SIG_INPUTS) using the same OutputConfig shape as
 *    utils/cashu/escrow-checkout.ts buildEscrowLockOutputConfig
 * 4. checkProofsStates -> UNSPENT
 * 5. after locktime, buyer refund-spends with their witness key
 *
 * Run: node scripts/probe-testnut-mint.mjs
 */
import {
  Mint as CashuMint,
  Wallet as CashuWallet,
  getEncodedToken,
  signP2PKProofs,
} from "@cashu/cashu-ts";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";

const MINT = process.env.PROBE_MINT_URL ?? "https://testnut.cashu.space";
const MINT_AMOUNT = 32; // minted balance (covers lock amount + swap fees)
const AMOUNT = 16; // locked into the escrow
const LOCK_SECONDS = Number(process.env.PROBE_LOCK_SECONDS ?? 90);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const buyerSk = generateSecretKey();
  const buyerPk = getPublicKey(buyerSk);
  const sellerSk = generateSecretKey();
  const sellerPk = getPublicKey(sellerSk);
  console.log("buyer pubkey:", buyerPk);
  console.log("seller pubkey:", sellerPk);

  const mint = new CashuMint(MINT);
  const wallet = new CashuWallet(mint);
  await wallet.loadMint();

  // 1+2. quote -> paid -> mint proofs
  const quote = await wallet.createMintQuoteBolt11(MINT_AMOUNT);
  console.log("quote:", quote.quote, "state:", quote.state);
  let state = await wallet.checkMintQuoteBolt11(quote.quote);
  let waited = 0;
  while (state.state !== "PAID" && waited < 60_000) {
    await sleep(2000);
    waited += 2000;
    state = await wallet.checkMintQuoteBolt11(quote.quote);
  }
  console.log("quote state after wait:", state.state);
  if (state.state !== "PAID") throw new Error("quote never became PAID");
  const proofs = await wallet.mintProofsBolt11(MINT_AMOUNT, quote.quote);
  console.log(
    "minted proofs:",
    proofs.length,
    "total",
    proofs.reduce((a, p) => a + p.amount, 0)
  );

  // 3. escrow P2PK lock swap (mirrors buildEscrowLockOutputConfig)
  const expiresAt = Math.floor(Date.now() / 1000) + LOCK_SECONDS;
  const outputConfig = {
    send: {
      type: "p2pk",
      options: {
        pubkey: sellerPk,
        locktime: expiresAt,
        refundKeys: [buyerPk],
        sigFlag: "SIG_INPUTS",
      },
    },
  };
  const { send } = await wallet.send(AMOUNT, proofs, { proofsWeHave: proofs }, outputConfig);
  console.log(
    "locked send proofs:",
    send.map((p) => ({ amount: p.amount, secret: p.secret.slice(0, 90) }))
  );
  const lockedToken = getEncodedToken({ mint: MINT, proofs: send, unit: "sat" });

  // 4. states pre-expiry
  const states = await wallet.checkProofsStates(send);
  console.log(
    "states pre-expiry:",
    states.map((s) => s.state)
  );

  // 5. wait for locktime then refund-spend with buyer key
  const waitMs = expiresAt * 1000 - Date.now() + 3000;
  console.log(`waiting ${Math.round(waitMs / 1000)}s for locktime...`);
  await sleep(Math.max(waitMs, 0));
  const recvWallet = new CashuWallet(mint, { unit: "sat" });
  await recvWallet.loadMint();
  const signedLocked = await signP2PKProofs(send, bytesToHex(buyerSk));
  const refunded = await recvWallet.receive({ mint: MINT, unit: "sat", proofs: signedLocked });
  console.log(
    "refund received proofs:",
    refunded.length,
    "total",
    refunded.reduce((a, p) => a + p.amount, 0)
  );
  const post = await recvWallet.checkProofsStates(send);
  console.log(
    "locked proof states post-refund:",
    post.map((s) => s.state)
  );
  console.log("PROBE OK");
}

main().catch((e) => {
  console.error("PROBE FAILED:", e);
  process.exit(1);
});
