import { getFiatValue, getSatoshiValue } from "@getalby/lightning-tools";

/**
 * Stable code identifying a checkout failure caused by the sats->fiat
 * exchange-rate service being down or returning garbage. Server routes stamp
 * this on their error JSON so the buyer-facing checkout UI can show a clear,
 * retry-oriented message instead of a generic failure.
 */
export const EXCHANGE_RATE_ERROR_CODE = "EXCHANGE_RATE_UNAVAILABLE";

/** Friendly, retry-oriented message shown to buyers paying in Bitcoin/sats. */
export const EXCHANGE_RATE_BUYER_MESSAGE =
  "We couldn't get the current exchange rate to convert your order. Please try again in a moment.";

/**
 * Thrown when the crypto->fiat conversion can't be completed because the
 * exchange-rate feed is unavailable or returned a non-finite/non-positive
 * value. Carries a stable `code` so API routes can surface a buyer-friendly,
 * retry-oriented error without brittle message matching.
 */
export class ExchangeRateError extends Error {
  readonly code = EXCHANGE_RATE_ERROR_CODE;
  constructor(message = EXCHANGE_RATE_BUYER_MESSAGE) {
    super(message);
    this.name = "ExchangeRateError";
  }
}

/** True when an unknown thrown value is an exchange-rate failure. */
export const isExchangeRateError = (error: unknown): boolean =>
  error instanceof ExchangeRateError ||
  (typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === EXCHANGE_RATE_ERROR_CODE);

export const ZERO_DECIMAL_CURRENCIES = new Set([
  "bif",
  "clp",
  "djf",
  "gnf",
  "jpy",
  "kmf",
  "krw",
  "mga",
  "pyg",
  "rwf",
  "ugx",
  "vnd",
  "vuv",
  "xaf",
  "xof",
  "xpf",
]);

export const isCrypto = (cur: string): boolean => {
  const c = cur.toLowerCase();
  return c === "sats" || c === "sat" || c === "btc";
};

export const isSatsCurrency = (cur: string): boolean => {
  const c = cur.toLowerCase();
  return c === "sats" || c === "sat" || c === "satoshi";
};

/**
 * Stripe enforces a minimum charge of $0.50 USD (or its smallest-unit
 * equivalent) on every PaymentIntent. We mirror that floor in the UI so the
 * displayed price always matches what Stripe will actually charge.
 */
export const STRIPE_MINIMUM_CHARGE_USD = 0.5;
export const STRIPE_MINIMUM_CHARGE_CENTS = 50;

export const applyStripeFloor = (amount: number, currency: string): number => {
  if (!isFinite(amount) || amount <= 0) return STRIPE_MINIMUM_CHARGE_USD;
  const c = currency.toLowerCase();
  if (isSatsCurrency(c) || c === "btc") {
    // For crypto-denominated displays we keep the original amount; the floor
    // is surfaced via the USD-equivalent line which is computed separately.
    return amount;
  }
  if (ZERO_DECIMAL_CURRENCIES.has(c)) {
    return Math.max(STRIPE_MINIMUM_CHARGE_CENTS, Math.ceil(amount));
  }
  // Standard fiat — round up to the nearest cent, then enforce the floor.
  return Math.max(STRIPE_MINIMUM_CHARGE_USD, Math.ceil(amount * 100) / 100);
};

/** True when the displayed amount is being raised by the Stripe floor. */
export const isAtStripeFloor = (amount: number, currency: string): boolean => {
  if (!isFinite(amount) || amount <= 0) return true;
  const c = currency.toLowerCase();
  if (isSatsCurrency(c) || c === "btc") return false;
  if (ZERO_DECIMAL_CURRENCIES.has(c)) {
    return Math.ceil(amount) < STRIPE_MINIMUM_CHARGE_CENTS;
  }
  return Math.ceil(amount * 100) / 100 < STRIPE_MINIMUM_CHARGE_USD;
};

/**
 * Round a price UP to its smallest displayable unit for the given currency.
 * - Sats / zero-decimal fiat → ceil to the nearest whole unit
 * - All other fiat → ceil to the nearest cent
 * BTC is treated as 8-decimal precision (1 satoshi).
 */
export const roundUpPrice = (amount: number, currency: string): number => {
  if (!isFinite(amount) || amount <= 0) return 0;
  const c = currency.toLowerCase();
  if (isSatsCurrency(c) || ZERO_DECIMAL_CURRENCIES.has(c)) {
    return Math.ceil(amount);
  }
  if (c === "btc") {
    return Math.ceil(amount * 100000000) / 100000000;
  }
  return Math.ceil(amount * 100) / 100;
};

export const toSmallestUnit = (amount: number, cur: string): number => {
  return ZERO_DECIMAL_CURRENCIES.has(cur.toLowerCase())
    ? Math.ceil(amount)
    : Math.ceil(amount * 100);
};

/**
 * Tunables for surviving a brief exchange-rate hiccup without reintroducing the
 * mis-charge risk that the fail-closed behavior guards against:
 * - `maxAttempts` total tries (1 initial + retries) against `getFiatValue`.
 * - `retryBaseMs` exponential backoff base between attempts (250ms, 500ms, ...).
 * - `cacheMaxAgeMs` strict freshness bound on the last-good rate used as a final
 *   fallback. Kept short so a cached rate can never silently mis-charge a buyer.
 * Exposed as a mutable object so tests can shrink the timings deterministically.
 */
export const exchangeRateRetryConfig = {
  maxAttempts: 3,
  retryBaseMs: 250,
  cacheMaxAgeMs: 60_000,
};

type CachedExchangeRate = { usdPerSat: number; fetchedAt: number };

/**
 * Module-level last-good rate. Persists across requests within a server process
 * so a transient outage can fall back to a very recently observed rate. Reset
 * via `_resetExchangeRateCache` in tests.
 */
let cachedExchangeRate: CachedExchangeRate | null = null;

/** Test-only: clear the in-process last-good rate cache between cases. */
export const _resetExchangeRateCache = (): void => {
  cachedExchangeRate = null;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** A finite, positive USD amount from the feed, or null if the value is junk. */
const validUsdOrNull = (value: unknown): number | null =>
  typeof value === "number" && isFinite(value) && value > 0 ? value : null;

export const satsToUSD = async (sats: number): Promise<number> => {
  const attempts = Math.max(1, exchangeRateRetryConfig.maxAttempts);
  const cacheable = isFinite(sats) && sats > 0;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    // Back off between attempts so we don't hammer a feed that's briefly down.
    if (attempt > 0) {
      await sleep(exchangeRateRetryConfig.retryBaseMs * 2 ** (attempt - 1));
    }
    try {
      const usdAmount = validUsdOrNull(
        await getFiatValue({ satoshi: sats, currency: "usd" })
      );
      // A degraded feed can resolve to NaN/Infinity/0/non-number; treat that
      // like a transient failure (retry), and fail closed if it never recovers,
      // so a nonsensical value never flows into the charge math.
      if (usdAmount === null) {
        lastError = new ExchangeRateError();
        continue;
      }
      // Success: refresh the short-lived last-good rate (USD per sat is linear,
      // so it can be reapplied to any sats amount within the freshness window).
      if (cacheable) {
        cachedExchangeRate = {
          usdPerSat: usdAmount / sats,
          fetchedAt: Date.now(),
        };
      }
      return usdAmount;
    } catch (err) {
      // The upstream rate feed threw (network down, timeout, etc). Remember it
      // and retry; the original message is preserved for server-side debugging.
      lastError = err;
    }
  }

  // Every attempt failed. As a last resort reuse a very recently cached rate so
  // a brief outage doesn't fail an otherwise-valid checkout — but only within a
  // strict freshness bound, so a stale rate can never silently mis-charge.
  if (
    cacheable &&
    cachedExchangeRate &&
    Date.now() - cachedExchangeRate.fetchedAt <=
      exchangeRateRetryConfig.cacheMaxAgeMs
  ) {
    const usdAmount = validUsdOrNull(cachedExchangeRate.usdPerSat * sats);
    if (usdAmount !== null) {
      return usdAmount;
    }
  }

  // Persistent failure: preserve the fail-closed behavior, re-tagging the error
  // so callers can surface a retry-oriented message.
  throw new ExchangeRateError(
    lastError instanceof Error ? lastError.message : EXCHANGE_RATE_BUYER_MESSAGE
  );
};

/**
 * Per-currency last-good FX rate cache for the BUYER-FACING display path. The
 * Alby feed returns a linear rate (sats-per-currency-unit or fiat-per-sat), so
 * the observed `ratio` can be reapplied to any amount of the same currency
 * within the freshness window. Separate from `cachedExchangeRate` (which backs
 * the server-side charge math) because the display path runs in the browser and
 * touches arbitrary currencies, not just USD-per-sat.
 */
type DisplayRate = { ratio: number; fetchedAt: number };
const displayRateCache = new Map<string, DisplayRate>();

/** Test-only: clear the in-process display FX cache between cases. */
export const _resetDisplayRateCache = (): void => {
  displayRateCache.clear();
};

/**
 * Shared resilient FX lookup for the buyer-facing price displays. Mirrors
 * `satsToUSD`'s retry + bounded-freshness behavior so a momentary feed hiccup
 * doesn't blank out or break a displayed converted price even though checkout
 * itself would now survive the same blip. Unlike the charge-math path it returns
 * `null` (rather than throwing) on persistent failure so callers can render a
 * graceful placeholder. A very recently observed rate is reused only within
 * `exchangeRateRetryConfig.cacheMaxAgeMs`, so a stale rate is never shown.
 */
const resilientDisplayRate = async (
  cacheKey: string,
  input: number,
  fetchValue: () => Promise<unknown>
): Promise<number | null> => {
  const attempts = Math.max(1, exchangeRateRetryConfig.maxAttempts);
  const cacheable = isFinite(input) && input > 0;

  for (let attempt = 0; attempt < attempts; attempt++) {
    // Back off between attempts so we don't hammer a feed that's briefly down.
    if (attempt > 0) {
      await sleep(exchangeRateRetryConfig.retryBaseMs * 2 ** (attempt - 1));
    }
    try {
      const value = validUsdOrNull(await fetchValue());
      // A degraded feed can resolve to NaN/Infinity/0/non-number; treat that
      // like a transient failure (retry), and fall back to cache / null if it
      // never recovers, so a nonsensical value never reaches the display.
      if (value === null) continue;
      if (cacheable) {
        displayRateCache.set(cacheKey, {
          ratio: value / input,
          fetchedAt: Date.now(),
        });
      }
      return value;
    } catch {
      // Transient throw (network down, timeout, etc) — retry.
    }
  }

  // Every attempt failed. Reuse a very recently cached rate within the strict
  // freshness bound so a brief outage doesn't blank the displayed price; never
  // beyond the bound, so a stale rate can't silently mislead the buyer.
  if (cacheable) {
    const cached = displayRateCache.get(cacheKey);
    if (
      cached &&
      Date.now() - cached.fetchedAt <= exchangeRateRetryConfig.cacheMaxAgeMs
    ) {
      return validUsdOrNull(cached.ratio * input);
    }
  }

  return null;
};

/**
 * Resilient fiat->sats conversion for buyer-facing displays. Returns the
 * satoshi-equivalent of `amount` in `currency`, or `null` after a persistent
 * outage (callers render a placeholder).
 */
export const getSatoshiValueResilient = async (args: {
  amount: number;
  currency: string;
}): Promise<number | null> =>
  resilientDisplayRate(`sats:${args.currency.toUpperCase()}`, args.amount, () =>
    getSatoshiValue({ amount: args.amount, currency: args.currency })
  );

/**
 * Resilient sats->fiat conversion for buyer-facing displays. Returns the
 * fiat-equivalent of `satoshi` in `currency`, or `null` after a persistent
 * outage (callers render a placeholder).
 */
export const getFiatValueResilient = async (args: {
  satoshi: number;
  currency: string;
}): Promise<number | null> =>
  resilientDisplayRate(
    `fiat:${args.currency.toUpperCase()}`,
    args.satoshi,
    () => getFiatValue({ satoshi: args.satoshi, currency: args.currency })
  );

export const convertToSmallestUnit = async (
  amount: number,
  currency: string
): Promise<{ amountSmallest: number; stripeCurrency: string }> => {
  if (isCrypto(currency)) {
    const sats = currency.toLowerCase() === "btc" ? amount * 100000000 : amount;
    const usdAmount = await satsToUSD(sats);
    const amountSmallest = Math.ceil(usdAmount * 100);
    // Defense in depth: never hand Stripe a non-finite/non-positive amount even
    // if the rate validation above is ever loosened.
    if (!isFinite(amountSmallest) || amountSmallest <= 0) {
      throw new ExchangeRateError();
    }
    return {
      amountSmallest,
      stripeCurrency: "usd",
    };
  }
  return {
    amountSmallest: toSmallestUnit(amount, currency),
    stripeCurrency: currency.toLowerCase(),
  };
};
