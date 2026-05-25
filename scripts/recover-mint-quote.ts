/**
 * One-shot recovery script for a stuck Milk Market mint quote.
 *
 * Use this when a buyer paid a Lightning invoice but the proofs were never
 * claimed by the browser (status `paid_unclaimed` in their
 * `milkmarket.pendingMintQuotes` localStorage entry). This calls the mint
 * directly with the quote ID, mints the owed proofs, and prints a
 * `cashuB…` token the buyer can redeem in any Cashu wallet (or melt to a
 * Lightning address).
 *
 * USAGE
 *   npx tsx scripts/recover-mint-quote.ts \
 *     --mint <mintUrl> \
 *     --quote <quoteId> \
 *     --amount <sats> \
 *     [--out <file>]
 *
 * Or, more conveniently, paste the JSON entry from the buyer's localStorage:
 *
 *   npx tsx scripts/recover-mint-quote.ts --json '{"quoteId":"...","mintUrl":"https://...","amount":1234,...}'
 *
 * The recovered token is printed to stdout. With `--out <file>` it is also
 * written to that file (the file will contain ONLY the token string so it
 * can be safely emailed/pasted).
 */

import {
  Mint as CashuMint,
  Wallet as CashuWallet,
  getEncodedToken,
  type Proof,
} from "@cashu/cashu-ts";
import { writeFileSync } from "node:fs";
import { sumProofAmounts } from "../utils/cashu/proof-amount";

interface RecoveryInput {
  mintUrl: string;
  quoteId: string;
  amount: number;
  outPath?: string;
}

function parseArgs(argv: string[]): RecoveryInput {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const val = argv[i + 1];
    if (val === undefined || val.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    args.set(key, val);
    i++;
  }

  const outPath = args.get("out");

  if (args.has("json")) {
    const parsed = JSON.parse(args.get("json")!) as {
      quoteId?: string;
      mintUrl?: string;
      amount?: number;
    };
    if (
      !parsed.quoteId ||
      !parsed.mintUrl ||
      typeof parsed.amount !== "number"
    ) {
      throw new Error(
        "--json must contain quoteId (string), mintUrl (string), and amount (number)"
      );
    }
    return {
      mintUrl: parsed.mintUrl,
      quoteId: parsed.quoteId,
      amount: parsed.amount,
      outPath,
    };
  }

  const mintUrl = args.get("mint");
  const quoteId = args.get("quote");
  const amountRaw = args.get("amount");
  if (!mintUrl || !quoteId || !amountRaw) {
    throw new Error(
      "Required flags: --mint <url> --quote <id> --amount <sats>  (or --json '<entry>')"
    );
  }
  const amount = Number(amountRaw);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(amount)) {
    throw new Error(`--amount must be a positive integer (got "${amountRaw}")`);
  }
  return { mintUrl, quoteId, amount, outPath };
}

async function main() {
  const input = parseArgs(process.argv.slice(2));

  console.error(`[recover] mint:   ${input.mintUrl}`);
  console.error(`[recover] quote:  ${input.quoteId}`);
  console.error(`[recover] amount: ${input.amount} sats`);

  const mint = new CashuMint(input.mintUrl);
  const wallet = new CashuWallet(mint);
  await wallet.loadMint();

  // 1) Sanity-check the quote state with the mint.
  const state = await wallet.checkMintQuoteBolt11(input.quoteId);
  console.error(`[recover] mint reports quote state: ${state.state}`);

  if (state.state === "UNPAID") {
    console.error(
      "[recover] FAIL — the mint says this invoice was never paid. Nothing to recover."
    );
    process.exit(2);
  }
  if (state.state === "ISSUED") {
    console.error(
      "[recover] FAIL — the mint says proofs for this quote were already issued."
    );
    console.error(
      "         Someone (another tab, another device, or a prior recovery) already"
    );
    console.error(
      "         claimed these proofs. They are not recoverable client-side from here."
    );
    process.exit(3);
  }
  if (state.state !== "PAID") {
    console.error(
      `[recover] FAIL — unexpected mint quote state: ${state.state}`
    );
    process.exit(4);
  }

  // 2) Mint the proofs.
  let proofs: Proof[];
  try {
    proofs = await wallet.mintProofsBolt11(input.amount, input.quoteId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.toLowerCase().includes("issued") ||
      msg.toLowerCase().includes("already")
    ) {
      console.error(
        "[recover] FAIL — mint reports quote already issued. Funds not recoverable client-side."
      );
      process.exit(3);
    }
    console.error(`[recover] FAIL — mintProofsBolt11 threw: ${msg}`);
    process.exit(5);
  }

  if (!proofs || proofs.length === 0) {
    console.error(
      "[recover] FAIL — mint returned 0 proofs. Try again in a moment."
    );
    process.exit(6);
  }

  const total = sumProofAmounts(proofs);
  console.error(
    `[recover] minted ${proofs.length} proofs totalling ${total} sats`
  );

  // 3) Encode as a Cashu token string for the buyer to redeem.
  const token = getEncodedToken({ mint: input.mintUrl, proofs });

  if (input.outPath) {
    writeFileSync(input.outPath, token, "utf8");
    console.error(`[recover] token written to ${input.outPath}`);
  }

  // Print ONLY the token to stdout so it can be piped/copied cleanly.
  process.stdout.write(token + "\n");
  console.error("[recover] DONE. Hand the token above to the buyer.");
}

main().catch((err) => {
  console.error("[recover] unhandled error:", err);
  process.exit(1);
});
