import AsyncStorage from "@react-native-async-storage/async-storage";
// v4 SDK exports the classes as Mint/Wallet (web aliases them the same way).
import { Amount, getEncodedToken, Mint, Wallet } from "@cashu/cashu-ts";

// Cashu fallback for PoS Lightning invoices: when the seller has no NWC
// connection, their configured mint (Settings → Account → Mint) issues the
// BOLT11 invoice instead. On payment the mint's fresh proofs are claimed into
// a mobile-local, per-pubkey wallet so the sale's funds are never stranded at
// the mint.
//
// Live-only SDK requirements honored here (mocked tests can't see them):
// - loadMint() before EVERY op on a fresh wallet ("Mint info not initialized")
// - mintProofsBolt11 amount must equal the createMintQuoteBolt11 amount
// - decoded proof amounts are Amount instances that JSON-serialize as
//   strings — coerce through Number() before persisting
// The web-side cashu-api-contract test guards these method names against SDK
// upgrades; mobile consumes the same pinned @cashu/cashu-ts.
//
// Logout sweep: these keys are deliberately NOT cleared on logout — proofs are
// bearer funds, and wiping them would burn money. Keys are pubkey-scoped so a
// different seller on the same device never sees them.

const WALLET_PREFIX = "self-sown:cashu-pos:wallet";
const PENDING_QUOTES_PREFIX = "self-sown:cashu-pos:pending-quotes";

/** Unpaid/paid-but-unclaimed quotes older than this are abandoned. */
const PENDING_QUOTE_TTL_MS = 48 * 60 * 60 * 1000;

interface StoredProof {
  amount: number;
  id: string;
  secret: string;
  C: string;
}

interface PendingQuote {
  mintUrl: string;
  quoteId: string;
  amountSats: number;
  createdAt: number;
}

export interface CashuInvoice {
  invoice: string;
  quoteId: string;
}

async function readJson<T>(key: string, fallback: T): Promise<T> {
  const raw = await AsyncStorage.getItem(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function loadPendingQuotes(pubkey: string): Promise<PendingQuote[]> {
  const parsed = await readJson<unknown>(
    `${PENDING_QUOTES_PREFIX}:${pubkey}`,
    []
  );
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (entry): entry is PendingQuote =>
      Boolean(entry) &&
      typeof entry === "object" &&
      typeof (entry as PendingQuote).mintUrl === "string" &&
      typeof (entry as PendingQuote).quoteId === "string" &&
      typeof (entry as PendingQuote).amountSats === "number"
  );
}

async function savePendingQuotes(
  pubkey: string,
  quotes: PendingQuote[]
): Promise<void> {
  const key = `${PENDING_QUOTES_PREFIX}:${pubkey}`;
  if (quotes.length === 0) {
    await AsyncStorage.removeItem(key);
    return;
  }
  await AsyncStorage.setItem(key, JSON.stringify(quotes.slice(-50)));
}

async function loadWallet(pubkey: string): Promise<Record<string, StoredProof[]>> {
  const parsed = await readJson<unknown>(`${WALLET_PREFIX}:${pubkey}`, {});
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const wallet: Record<string, StoredProof[]> = {};
  for (const [mintUrl, proofs] of Object.entries(parsed)) {
    if (!Array.isArray(proofs)) continue;
    wallet[mintUrl] = proofs.filter(
      (proof): proof is StoredProof =>
        Boolean(proof) &&
        typeof proof === "object" &&
        typeof (proof as StoredProof).amount === "number" &&
        typeof (proof as StoredProof).secret === "string"
    );
  }
  return wallet;
}

/** A fresh wallet for one op. loadMint is mandatory before any quote op. */
async function openMintWallet(mintUrl: string): Promise<Wallet> {
  const wallet = new Wallet(new Mint(mintUrl), { unit: "sat" });
  await wallet.loadMint();
  return wallet;
}

/**
 * Persist a quote BEFORE showing its QR. If the app dies after the buyer pays
 * but before the claim lands, the sweep on the next PoS open claims it — a
 * paid sale must never become unclaimable funds.
 */
export async function recordPendingCashuQuote(
  pubkey: string,
  quote: PendingQuote
): Promise<void> {
  const quotes = await loadPendingQuotes(pubkey);
  if (quotes.some((existing) => existing.quoteId === quote.quoteId)) return;
  quotes.push(quote);
  await savePendingQuotes(pubkey, quotes);
}

export async function createCashuMintInvoice(
  mintUrl: string,
  amountSats: number,
  description: string
): Promise<CashuInvoice> {
  const wallet = await openMintWallet(mintUrl);
  const quote = await wallet.createMintQuoteBolt11(amountSats, description);
  return { invoice: quote.request, quoteId: quote.quote };
}

/** PAID = buyer paid, proofs not yet claimed; ISSUED = already claimed. */
export async function checkCashuQuotePaid(
  mintUrl: string,
  quoteId: string
): Promise<boolean> {
  const wallet = await openMintWallet(mintUrl);
  const state = await wallet.checkMintQuoteBolt11(quoteId);
  return state.state === "PAID" || state.state === "ISSUED";
}

/**
 * Claim a paid quote's proofs into the mobile wallet. The mint rejects the
 * claim if the amount differs from the quote amount by even 1 sat.
 */
export async function claimCashuQuote(
  pubkey: string,
  pending: PendingQuote
): Promise<number> {
  const wallet = await openMintWallet(pending.mintUrl);
  const proofs = await wallet.mintProofsBolt11(
    pending.amountSats,
    pending.quoteId
  );
  const normalized: StoredProof[] = proofs.map((proof) => ({
    // v4 Amount instances JSON-serialize as strings; store plain numbers.
    amount: Number(proof.amount),
    id: String(proof.id),
    secret: String(proof.secret),
    C: String(proof.C),
  }));
  const walletData = await loadWallet(pubkey);
  const existing = walletData[pending.mintUrl] ?? [];
  const seen = new Set(existing.map((proof) => proof.secret));
  walletData[pending.mintUrl] = [
    ...existing,
    ...normalized.filter((proof) => !seen.has(proof.secret)),
  ];
  await AsyncStorage.setItem(
    `${WALLET_PREFIX}:${pubkey}`,
    JSON.stringify(walletData)
  );
  const quotes = await loadPendingQuotes(pubkey);
  await savePendingQuotes(
    pubkey,
    quotes.filter((entry) => entry.quoteId !== pending.quoteId)
  );
  return normalized.reduce((sum, proof) => sum + proof.amount, 0);
}

/**
 * Claim any pending quotes that got paid while the app was away. Called on
 * PoS mount alongside flushPendingPosRecords. Unpaid quotes stay until the
 * TTL — a buyer can pay an expired-screen invoice minutes later.
 */
export async function sweepPendingCashuQuotes(
  pubkey: string
): Promise<number> {
  const quotes = await loadPendingQuotes(pubkey);
  if (quotes.length === 0) return 0;
  const now = Date.now();
  const keep: PendingQuote[] = [];
  let claimed = 0;
  for (const quote of quotes) {
    if (now - quote.createdAt > PENDING_QUOTE_TTL_MS) continue;
    try {
      if (await checkCashuQuotePaid(quote.mintUrl, quote.quoteId)) {
        await claimCashuQuote(pubkey, quote);
        claimed += 1;
        continue;
      }
    } catch {
      // A mint/relay hiccup must not strand the rest of the queue.
    }
    keep.push(quote);
  }
  await savePendingQuotes(pubkey, keep);
  return claimed;
}

/** Per-mint balances in sats, for the Settings display. */
export async function getCashuPosBalances(
  pubkey: string
): Promise<Record<string, number>> {
  const wallet = await loadWallet(pubkey);
  const balances: Record<string, number> = {};
  for (const [mintUrl, proofs] of Object.entries(wallet)) {
    if (proofs.length === 0) continue;
    balances[mintUrl] = proofs.reduce((sum, proof) => sum + proof.amount, 0);
  }
  return balances;
}

/**
 * Encode a mint's full local balance as a cashu token and CLEAR it locally —
 * once the seller can copy/share the token, those proofs belong to it (the
 * wallet's copy would be a double-spend waiting to happen).
 */
export async function exportCashuPosToken(
  pubkey: string,
  mintUrl: string
): Promise<string> {
  const wallet = await loadWallet(pubkey);
  const proofs = wallet[mintUrl] ?? [];
  if (proofs.length === 0) {
    throw new Error("No ecash balance at this mint.");
  }
  const token = getEncodedToken({
    mint: mintUrl,
    // Stored amounts are plain numbers; Proof wants the v4 Amount wrapper.
    proofs: proofs.map((proof) => ({
      ...proof,
      amount: Amount.from(proof.amount),
    })),
    unit: "sat",
  });
  delete wallet[mintUrl];
  await AsyncStorage.setItem(
    `${WALLET_PREFIX}:${pubkey}`,
    JSON.stringify(wallet)
  );
  return token;
}
