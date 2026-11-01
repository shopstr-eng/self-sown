// Fiat <-> sats conversion for PoS Lightning charges. Mirrors the web's
// fail-closed exchange-rate rule (utils/stripe/currency.ts): retry a degraded
// feed, reuse a very recent last-good rate, and otherwise throw a clear
// retry-oriented error rather than invoicing a nonsense amount.

const PRICE_FEED_URL = "https://mempool.space/api/v1/prices";
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 400;
const CACHE_MAX_AGE_MS = 5 * 60 * 1000;

export const POS_FX_ERROR_CODE = "POS_EXCHANGE_RATE_UNAVAILABLE";
export const POS_FX_ERROR_MESSAGE =
  "Couldn't get the current Bitcoin price. Check your connection and try again.";

export class PosFxError extends Error {
  readonly code = POS_FX_ERROR_CODE;
  constructor(message = POS_FX_ERROR_MESSAGE) {
    super(message);
    this.name = "PosFxError";
  }
}

// Currencies with no minor unit — charging ¥12.34 is invalid.
const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF",
  "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
]);

export function isSatsCurrency(currency: string): boolean {
  const c = currency.trim().toUpperCase();
  return c === "SATS" || c === "SAT" || c === "BTC";
}

/** Major units -> smallest units (cents for USD, whole yen for JPY). */
export function toSmallestUnit(amount: number, currency: string): number {
  if (!Number.isFinite(amount) || amount < 0) return NaN;
  if (isSatsCurrency(currency)) return Math.round(amount);
  const decimals = ZERO_DECIMAL_CURRENCIES.has(currency.trim().toUpperCase())
    ? 0
    : 2;
  return Math.round(amount * 10 ** decimals);
}

/** Display formatting for cart/charge amounts. */
export function formatPosAmount(amount: number, currency: string): string {
  if (isSatsCurrency(currency)) {
    return `${Math.round(amount).toLocaleString()} sats`;
  }
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency.toUpperCase()}`;
  }
}

type CachedRate = { fiatPerBtc: number; fetchedAt: number };
const rateCache = new Map<string, CachedRate>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchFiatPerBtc(currency: string): Promise<number> {
  const response = await fetch(PRICE_FEED_URL, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new PosFxError();
  const data = (await response.json()) as Record<string, unknown>;
  const value = data[currency];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new PosFxError();
  }
  return value;
}

/** Convert a fiat major-unit amount to whole sats. Fail-closed. */
export async function fiatToSats(
  amount: number,
  currencyInput: string
): Promise<number> {
  const currency = currencyInput.trim().toUpperCase();
  if (!Number.isFinite(amount) || amount <= 0 || !/^[A-Z]{3}$/.test(currency)) {
    throw new PosFxError();
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
    try {
      const fiatPerBtc = await fetchFiatPerBtc(currency);
      rateCache.set(currency, { fiatPerBtc, fetchedAt: Date.now() });
      const sats = Math.round((amount / fiatPerBtc) * 1e8);
      if (!Number.isInteger(sats) || sats <= 0) throw new PosFxError();
      return sats;
    } catch (error) {
      lastError = error;
    }
  }

  const cached = rateCache.get(currency);
  if (cached && Date.now() - cached.fetchedAt <= CACHE_MAX_AGE_MS) {
    const sats = Math.round((amount / cached.fiatPerBtc) * 1e8);
    if (Number.isInteger(sats) && sats > 0) return sats;
  }

  throw lastError instanceof PosFxError ? lastError : new PosFxError();
}
