/**
 * Repro: does cashu-ts send() with { includeFees: true } fail against
 * testnut (input_fee_ppk=100) where { proofsWeHave } succeeds?
 */
import { Mint, Wallet, getEncodedToken } from "@cashu/cashu-ts";
import { generateSecretKey, getPublicKey } from "nostr-tools";

const MINT = "https://testnut.cashu.space";
const wallet = new Wallet(new Mint(MINT));
await wallet.loadMint();

const quote = await wallet.createMintQuoteBolt11(500);
console.log("quote:", quote.quote.slice(0, 16), "waiting for auto-pay...");
let state = "UNPAID";
while (state !== "PAID") {
  await new Promise((r) => setTimeout(r, 1500));
  state = (await wallet.checkMintQuoteBolt11(quote.quote)).state;
}
const proofs = await wallet.mintProofsBolt11(500, quote.quote);
console.log(
  "minted:",
  proofs.reduce((s, p) => s + Number(p.amount), 0),
  "sats in",
  proofs.length,
  "proofs"
);

const sellerPk = getPublicKey(generateSecretKey());
const buyerPk = getPublicKey(generateSecretKey());
const outputConfig = {
  send: {
    type: "p2pk",
    options: {
      pubkey: sellerPk,
      locktime: Math.floor(Date.now() / 1000) + 600,
      refundKeys: [buyerPk],
      sigFlag: "SIG_INPUTS",
    },
  },
};

// Attempt 1: the app's exact config
try {
  const r1 = await wallet.send(
    100,
    proofs,
    { includeFees: true },
    outputConfig
  );
  console.log(
    "includeFees:true OK — send:",
    r1.send.reduce((s, p) => s + Number(p.amount), 0),
    "keep:",
    r1.keep.reduce((s, p) => s + Number(p.amount), 0)
  );
} catch (e) {
  console.log("includeFees:true FAILED:", e.message);
}

// Attempt 2: what the probe used before
try {
  const r2 = await wallet.send(
    100,
    proofs,
    { proofsWeHave: proofs },
    outputConfig
  );
  console.log(
    "proofsWeHave OK — send:",
    r2.send.reduce((s, p) => s + Number(p.amount), 0),
    "keep:",
    r2.keep.reduce((s, p) => s + Number(p.amount), 0)
  );
} catch (e) {
  console.log("proofsWeHave FAILED:", e.message);
}

// Attempt 3: no sendConfig at all
try {
  const r3 = await wallet.send(100, proofs, undefined, outputConfig);
  console.log(
    "no sendConfig OK — send:",
    r3.send.reduce((s, p) => s + Number(p.amount), 0)
  );
} catch (e) {
  console.log("no sendConfig FAILED:", e.message);
}
