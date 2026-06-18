/** @jest-environment node */

// Direct unit coverage for the money-rounding helpers in
// utils/stripe/currency.ts. These decide exactly how prices are rounded and how
// crypto is converted to USD cents at checkout, so a future rounding regression
// here would over- or under-charge a buyer. Today they're only exercised
// indirectly through the payment route.
//
// The only network-bound dependency is `getFiatValue` from
// @getalby/lightning-tools (used by satsToUSD, which convertToSmallestUnit calls
// internally). We mock the library so satsToUSD's internal caller picks up the
// mock too (mocking the satsToUSD export wouldn't affect the in-module call).

const getFiatValueMock = jest.fn();
const getSatoshiValueMock = jest.fn();

jest.mock("@getalby/lightning-tools", () => ({
  __esModule: true,
  getFiatValue: (...args: unknown[]) => getFiatValueMock(...args),
  getSatoshiValue: (...args: unknown[]) => getSatoshiValueMock(...args),
}));

import {
  toSmallestUnit,
  roundUpPrice,
  applyStripeFloor,
  isAtStripeFloor,
  convertToSmallestUnit,
  satsToUSD,
  getSatoshiValueResilient,
  getFiatValueResilient,
  exchangeRateRetryConfig,
  _resetExchangeRateCache,
  _resetDisplayRateCache,
  STRIPE_MINIMUM_CHARGE_USD,
  STRIPE_MINIMUM_CHARGE_CENTS,
} from "@/utils/stripe/currency";

const defaultRetryConfig = { ...exchangeRateRetryConfig };

beforeEach(() => {
  getFiatValueMock.mockReset();
  getSatoshiValueMock.mockReset();
  // Clear the in-process last-good rate cache so a success in one test can't
  // leak into another test's fail-closed assertion via the fallback path.
  _resetExchangeRateCache();
  // Clear the buyer-facing display FX cache for the same reason.
  _resetDisplayRateCache();
  // Restore timing defaults; individual tests shrink the backoff to stay fast.
  Object.assign(exchangeRateRetryConfig, defaultRetryConfig);
  // Keep retries instant by default so the failure-path suites don't sleep.
  exchangeRateRetryConfig.retryBaseMs = 0;
});

describe("toSmallestUnit", () => {
  it("scales standard fiat by 100 (cents), ceiling to the next cent", () => {
    expect(toSmallestUnit(1, "usd")).toBe(100);
    expect(toSmallestUnit(1.23, "usd")).toBe(123);
    // 19.99 * 100 floating-point ends just over 1999, so ceil must not over-round.
    expect(toSmallestUnit(19.99, "usd")).toBe(1999);
    // A fractional cent always rounds UP.
    expect(toSmallestUnit(1.231, "usd")).toBe(124);
    expect(toSmallestUnit(1.001, "eur")).toBe(101);
  });

  it("treats zero-decimal currencies as whole-unit (no *100), ceiling fractions", () => {
    expect(toSmallestUnit(1000, "jpy")).toBe(1000);
    expect(toSmallestUnit(1000.4, "jpy")).toBe(1001);
    expect(toSmallestUnit(5000, "krw")).toBe(5000);
  });

  it("is case-insensitive about the currency code", () => {
    expect(toSmallestUnit(1000, "JPY")).toBe(1000);
    expect(toSmallestUnit(1.23, "USD")).toBe(123);
  });
});

describe("roundUpPrice", () => {
  it("returns 0 for non-positive or non-finite amounts", () => {
    expect(roundUpPrice(0, "usd")).toBe(0);
    expect(roundUpPrice(-5, "usd")).toBe(0);
    expect(roundUpPrice(Infinity, "usd")).toBe(0);
    expect(roundUpPrice(NaN, "usd")).toBe(0);
  });

  it("ceils sats and zero-decimal fiat to whole units", () => {
    expect(roundUpPrice(100.1, "sats")).toBe(101);
    expect(roundUpPrice(100, "sats")).toBe(100);
    expect(roundUpPrice(100, "sat")).toBe(100);
    expect(roundUpPrice(999.0001, "jpy")).toBe(1000);
    expect(roundUpPrice(500, "krw")).toBe(500);
  });

  it("ceils btc to 8-decimal (1 satoshi) precision", () => {
    // 0.000000015 btc → 1.5 sats → ceil to 2 sats → 0.00000002 btc.
    expect(roundUpPrice(0.000000015, "btc")).toBeCloseTo(0.00000002, 12);
    // An exact-satoshi amount is unchanged.
    expect(roundUpPrice(0.0002, "btc")).toBeCloseTo(0.0002, 12);
  });

  it("ceils standard fiat to the nearest cent", () => {
    expect(roundUpPrice(1.231, "usd")).toBeCloseTo(1.24, 10);
    expect(roundUpPrice(1.001, "eur")).toBeCloseTo(1.01, 10);
    expect(roundUpPrice(5, "usd")).toBeCloseTo(5, 10);
  });
});

describe("applyStripeFloor", () => {
  it("returns the $0.50 floor for non-positive or non-finite amounts", () => {
    expect(applyStripeFloor(0, "usd")).toBe(STRIPE_MINIMUM_CHARGE_USD);
    expect(applyStripeFloor(-1, "usd")).toBe(STRIPE_MINIMUM_CHARGE_USD);
    expect(applyStripeFloor(NaN, "usd")).toBe(STRIPE_MINIMUM_CHARGE_USD);
    expect(applyStripeFloor(Infinity, "usd")).toBe(STRIPE_MINIMUM_CHARGE_USD);
  });

  it("passes crypto amounts through untouched (floor surfaced via USD line)", () => {
    expect(applyStripeFloor(1, "sats")).toBe(1);
    expect(applyStripeFloor(0.00000001, "btc")).toBe(0.00000001);
    expect(applyStripeFloor(123, "satoshi")).toBe(123);
  });

  it("enforces a 50-unit floor for zero-decimal currencies, ceiling otherwise", () => {
    expect(applyStripeFloor(10, "jpy")).toBe(STRIPE_MINIMUM_CHARGE_CENTS);
    expect(applyStripeFloor(49.1, "jpy")).toBe(50);
    expect(applyStripeFloor(100.2, "jpy")).toBe(101);
  });

  it("enforces the $0.50 floor for standard fiat, ceiling to the cent above it", () => {
    expect(applyStripeFloor(0.25, "usd")).toBe(STRIPE_MINIMUM_CHARGE_USD);
    expect(applyStripeFloor(0.5, "usd")).toBe(0.5);
    expect(applyStripeFloor(1.231, "usd")).toBeCloseTo(1.24, 10);
  });
});

describe("isAtStripeFloor", () => {
  it("reports true for non-positive or non-finite amounts", () => {
    expect(isAtStripeFloor(0, "usd")).toBe(true);
    expect(isAtStripeFloor(-1, "usd")).toBe(true);
    expect(isAtStripeFloor(NaN, "usd")).toBe(true);
    expect(isAtStripeFloor(Infinity, "usd")).toBe(true);
  });

  it("is never at the floor for crypto", () => {
    expect(isAtStripeFloor(0.00000001, "btc")).toBe(false);
    expect(isAtStripeFloor(1, "sats")).toBe(false);
  });

  it("flags zero-decimal amounts below the 50-unit floor", () => {
    expect(isAtStripeFloor(49, "jpy")).toBe(true);
    expect(isAtStripeFloor(50, "jpy")).toBe(false);
    expect(isAtStripeFloor(49.1, "jpy")).toBe(false); // ceil(49.1)=50, not < 50
  });

  it("flags standard fiat below the $0.50 floor", () => {
    expect(isAtStripeFloor(0.25, "usd")).toBe(true);
    expect(isAtStripeFloor(0.49, "usd")).toBe(true);
    expect(isAtStripeFloor(0.5, "usd")).toBe(false);
    expect(isAtStripeFloor(1, "usd")).toBe(false);
  });
});

describe("satsToUSD", () => {
  it("delegates to getFiatValue with the sats amount in USD", async () => {
    getFiatValueMock.mockResolvedValue(12.34);
    await expect(satsToUSD(10000)).resolves.toBe(12.34);
    expect(getFiatValueMock).toHaveBeenCalledTimes(1);
    expect(getFiatValueMock).toHaveBeenCalledWith({
      satoshi: 10000,
      currency: "usd",
    });
  });

  it("rejects when the rate service throws (network/feed down)", async () => {
    getFiatValueMock.mockRejectedValue(new Error("rate service unavailable"));
    await expect(satsToUSD(10000)).rejects.toThrow("rate service unavailable");
  });

  it("rejects a non-finite rate result instead of returning NaN/Infinity", async () => {
    getFiatValueMock.mockResolvedValue(NaN);
    await expect(satsToUSD(10000)).rejects.toThrow(/exchange rate/i);

    getFiatValueMock.mockResolvedValue(Infinity);
    await expect(satsToUSD(10000)).rejects.toThrow(/exchange rate/i);
  });

  it("rejects a zero or negative rate result", async () => {
    getFiatValueMock.mockResolvedValue(0);
    await expect(satsToUSD(10000)).rejects.toThrow(/exchange rate/i);

    getFiatValueMock.mockResolvedValue(-5);
    await expect(satsToUSD(10000)).rejects.toThrow(/exchange rate/i);
  });

  it("rejects a non-number rate result (garbage response)", async () => {
    getFiatValueMock.mockResolvedValue("12.34" as unknown as number);
    await expect(satsToUSD(10000)).rejects.toThrow(/exchange rate/i);
  });
});

describe("satsToUSD retry-with-backoff", () => {
  it("retries a transient throw and succeeds without erroring out", async () => {
    getFiatValueMock
      .mockRejectedValueOnce(new Error("transient timeout"))
      .mockResolvedValueOnce(12.34);
    await expect(satsToUSD(10000)).resolves.toBe(12.34);
    expect(getFiatValueMock).toHaveBeenCalledTimes(2);
  });

  it("retries a transient garbage value and succeeds on recovery", async () => {
    getFiatValueMock.mockResolvedValueOnce(NaN).mockResolvedValueOnce(7.5);
    await expect(satsToUSD(10000)).resolves.toBe(7.5);
    expect(getFiatValueMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after the configured number of attempts (fail closed)", async () => {
    getFiatValueMock.mockRejectedValue(new Error("feed down"));
    await expect(satsToUSD(10000)).rejects.toThrow("feed down");
    expect(getFiatValueMock).toHaveBeenCalledTimes(
      exchangeRateRetryConfig.maxAttempts
    );
  });

  it("backs off between attempts before giving up", async () => {
    exchangeRateRetryConfig.maxAttempts = 3;
    exchangeRateRetryConfig.retryBaseMs = 20;
    getFiatValueMock.mockRejectedValue(new Error("still down"));
    const start = Date.now();
    await expect(satsToUSD(10000)).rejects.toThrow("still down");
    // Two backoffs between three attempts: 20ms + 40ms = 60ms minimum.
    expect(Date.now() - start).toBeGreaterThanOrEqual(50);
  });
});

describe("satsToUSD last-good rate cache", () => {
  it("falls back to a fresh cached rate when the feed briefly fails", async () => {
    // Seed the cache with a good rate at 10000 sats → $5 (0.0005 USD/sat).
    getFiatValueMock.mockResolvedValueOnce(5);
    await expect(satsToUSD(10000)).resolves.toBe(5);

    // Feed now down for every attempt; a different sats amount reuses the rate.
    getFiatValueMock.mockReset();
    getFiatValueMock.mockRejectedValue(new Error("feed down"));
    await expect(satsToUSD(20000)).resolves.toBeCloseTo(10, 10);
  });

  it("does NOT use a cached rate older than the strict freshness bound", async () => {
    exchangeRateRetryConfig.cacheMaxAgeMs = 1000;
    const nowSpy = jest.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(0);
      getFiatValueMock.mockResolvedValueOnce(5);
      await expect(satsToUSD(10000)).resolves.toBe(5);

      // Jump past the freshness window; the stale rate must be rejected.
      nowSpy.mockReturnValue(2000);
      getFiatValueMock.mockReset();
      getFiatValueMock.mockRejectedValue(new Error("feed down"));
      await expect(satsToUSD(10000)).rejects.toThrow("feed down");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("fails closed when the feed fails and no cached rate exists", async () => {
    getFiatValueMock.mockRejectedValue(new Error("cold start, feed down"));
    await expect(satsToUSD(10000)).rejects.toThrow(/feed down/);
  });
});

describe("convertToSmallestUnit", () => {
  it("scales btc by 1e8 to sats before FX, then ceils USD to cents", async () => {
    getFiatValueMock.mockResolvedValue(2.005);
    const result = await convertToSmallestUnit(0.0002, "btc");
    // 0.0002 btc → 20000 sats handed to the FX call.
    expect(getFiatValueMock).toHaveBeenCalledWith({
      satoshi: 20000,
      currency: "usd",
    });
    // 2.005 USD → ceil(200.5) = 201 cents.
    expect(result).toEqual({ amountSmallest: 201, stripeCurrency: "usd" });
  });

  it("passes sats through as-is to FX, then ceils USD to cents", async () => {
    getFiatValueMock.mockResolvedValue(1.231);
    const result = await convertToSmallestUnit(10000, "sats");
    expect(getFiatValueMock).toHaveBeenCalledWith({
      satoshi: 10000,
      currency: "usd",
    });
    // 1.231 USD → ceil(123.1) = 124 cents.
    expect(result).toEqual({ amountSmallest: 124, stripeCurrency: "usd" });
  });

  it("converts standard fiat to cents without any FX call", async () => {
    const result = await convertToSmallestUnit(1.23, "usd");
    expect(getFiatValueMock).not.toHaveBeenCalled();
    expect(result).toEqual({ amountSmallest: 123, stripeCurrency: "usd" });
  });

  it("converts zero-decimal fiat as whole units, lowercasing the currency", async () => {
    const result = await convertToSmallestUnit(1000, "JPY");
    expect(getFiatValueMock).not.toHaveBeenCalled();
    expect(result).toEqual({ amountSmallest: 1000, stripeCurrency: "jpy" });
  });

  it("surfaces an error for crypto when the rate service is down (no silent fallback)", async () => {
    getFiatValueMock.mockRejectedValue(new Error("exchange rate feed down"));
    await expect(convertToSmallestUnit(10000, "sats")).rejects.toThrow();
    await expect(convertToSmallestUnit(0.0002, "btc")).rejects.toThrow();
  });

  it("rejects a non-finite rate rather than charging NaN cents", async () => {
    getFiatValueMock.mockResolvedValue(NaN);
    await expect(convertToSmallestUnit(10000, "sats")).rejects.toThrow(
      /exchange rate/i
    );
  });

  it("rejects a zero rate rather than charging 0 cents", async () => {
    getFiatValueMock.mockResolvedValue(0);
    await expect(convertToSmallestUnit(10000, "sats")).rejects.toThrow(
      /exchange rate/i
    );
  });
});

// Buyer-facing display conversions. Unlike the charge-math path, these RETURN
// null (never throw) on a persistent outage so the UI can render a placeholder,
// while still retrying a brief hiccup and reusing a very recently cached rate
// only within the strict freshness bound. They mock getSatoshiValue /
// getFiatValue and shrink exchangeRateRetryConfig timings just like satsToUSD.

describe("getSatoshiValueResilient", () => {
  it("delegates to getSatoshiValue and caches the rate on success", async () => {
    getSatoshiValueMock.mockResolvedValue(5000);
    await expect(
      getSatoshiValueResilient({ amount: 10, currency: "usd" })
    ).resolves.toBe(5000);
    expect(getSatoshiValueMock).toHaveBeenCalledTimes(1);
    expect(getSatoshiValueMock).toHaveBeenCalledWith({
      amount: 10,
      currency: "usd",
    });
  });

  it("retries a transient throw and then succeeds", async () => {
    getSatoshiValueMock
      .mockRejectedValueOnce(new Error("transient timeout"))
      .mockResolvedValueOnce(5000);
    await expect(
      getSatoshiValueResilient({ amount: 10, currency: "usd" })
    ).resolves.toBe(5000);
    expect(getSatoshiValueMock).toHaveBeenCalledTimes(2);
  });

  it("retries a transient garbage value and then succeeds", async () => {
    getSatoshiValueMock.mockResolvedValueOnce(NaN).mockResolvedValueOnce(5000);
    await expect(
      getSatoshiValueResilient({ amount: 10, currency: "usd" })
    ).resolves.toBe(5000);
    expect(getSatoshiValueMock).toHaveBeenCalledTimes(2);
  });

  it("returns null (never throws) after a persistent failure", async () => {
    getSatoshiValueMock.mockRejectedValue(new Error("feed down"));
    await expect(
      getSatoshiValueResilient({ amount: 10, currency: "usd" })
    ).resolves.toBeNull();
    expect(getSatoshiValueMock).toHaveBeenCalledTimes(
      exchangeRateRetryConfig.maxAttempts
    );
  });

  it("returns null when no cached rate exists and the feed is down", async () => {
    getSatoshiValueMock.mockResolvedValue(NaN);
    await expect(
      getSatoshiValueResilient({ amount: 10, currency: "usd" })
    ).resolves.toBeNull();
  });

  it("reuses a fresh cached rate when the feed briefly fails", async () => {
    // Seed the cache: 10 USD → 5000 sats (500 sats per USD unit).
    getSatoshiValueMock.mockResolvedValueOnce(5000);
    await expect(
      getSatoshiValueResilient({ amount: 10, currency: "usd" })
    ).resolves.toBe(5000);

    // Feed now down for every attempt; a different amount reuses the rate.
    getSatoshiValueMock.mockReset();
    getSatoshiValueMock.mockRejectedValue(new Error("feed down"));
    await expect(
      getSatoshiValueResilient({ amount: 20, currency: "usd" })
    ).resolves.toBeCloseTo(10000, 6);
  });

  it("does NOT reuse a cached rate older than the freshness bound", async () => {
    exchangeRateRetryConfig.cacheMaxAgeMs = 1000;
    const nowSpy = jest.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(0);
      getSatoshiValueMock.mockResolvedValueOnce(5000);
      await expect(
        getSatoshiValueResilient({ amount: 10, currency: "usd" })
      ).resolves.toBe(5000);

      // Jump past the freshness window; the stale rate must be rejected.
      nowSpy.mockReturnValue(2000);
      getSatoshiValueMock.mockReset();
      getSatoshiValueMock.mockRejectedValue(new Error("feed down"));
      await expect(
        getSatoshiValueResilient({ amount: 10, currency: "usd" })
      ).resolves.toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("keeps separate caches per currency", async () => {
    getSatoshiValueMock.mockResolvedValueOnce(5000);
    await getSatoshiValueResilient({ amount: 10, currency: "usd" });

    // A different currency has no cached rate, so an outage returns null
    // instead of reusing the USD rate.
    getSatoshiValueMock.mockReset();
    getSatoshiValueMock.mockRejectedValue(new Error("feed down"));
    await expect(
      getSatoshiValueResilient({ amount: 10, currency: "eur" })
    ).resolves.toBeNull();
  });
});

describe("getFiatValueResilient", () => {
  it("delegates to getFiatValue and caches the rate on success", async () => {
    getFiatValueMock.mockResolvedValue(12.34);
    await expect(
      getFiatValueResilient({ satoshi: 10000, currency: "usd" })
    ).resolves.toBe(12.34);
    expect(getFiatValueMock).toHaveBeenCalledTimes(1);
    expect(getFiatValueMock).toHaveBeenCalledWith({
      satoshi: 10000,
      currency: "usd",
    });
  });

  it("retries a transient throw and then succeeds", async () => {
    getFiatValueMock
      .mockRejectedValueOnce(new Error("transient timeout"))
      .mockResolvedValueOnce(12.34);
    await expect(
      getFiatValueResilient({ satoshi: 10000, currency: "usd" })
    ).resolves.toBe(12.34);
    expect(getFiatValueMock).toHaveBeenCalledTimes(2);
  });

  it("returns null (never throws) after a persistent failure", async () => {
    getFiatValueMock.mockRejectedValue(new Error("feed down"));
    await expect(
      getFiatValueResilient({ satoshi: 10000, currency: "usd" })
    ).resolves.toBeNull();
    expect(getFiatValueMock).toHaveBeenCalledTimes(
      exchangeRateRetryConfig.maxAttempts
    );
  });

  it("reuses a fresh cached rate when the feed briefly fails", async () => {
    // Seed the cache: 10000 sats → $5 (0.0005 USD per sat).
    getFiatValueMock.mockResolvedValueOnce(5);
    await expect(
      getFiatValueResilient({ satoshi: 10000, currency: "usd" })
    ).resolves.toBe(5);

    getFiatValueMock.mockReset();
    getFiatValueMock.mockRejectedValue(new Error("feed down"));
    await expect(
      getFiatValueResilient({ satoshi: 20000, currency: "usd" })
    ).resolves.toBeCloseTo(10, 10);
  });

  it("does NOT reuse a cached rate older than the freshness bound", async () => {
    exchangeRateRetryConfig.cacheMaxAgeMs = 1000;
    const nowSpy = jest.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(0);
      getFiatValueMock.mockResolvedValueOnce(5);
      await expect(
        getFiatValueResilient({ satoshi: 10000, currency: "usd" })
      ).resolves.toBe(5);

      nowSpy.mockReturnValue(2000);
      getFiatValueMock.mockReset();
      getFiatValueMock.mockRejectedValue(new Error("feed down"));
      await expect(
        getFiatValueResilient({ satoshi: 10000, currency: "usd" })
      ).resolves.toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("does not share a cache with the sats display path", async () => {
    // Prime the fiat:USD cache.
    getFiatValueMock.mockResolvedValueOnce(5);
    await getFiatValueResilient({ satoshi: 10000, currency: "usd" });

    // The sats:USD path is a separate cache key, so an outage there returns
    // null rather than borrowing the fiat rate.
    getSatoshiValueMock.mockRejectedValue(new Error("feed down"));
    await expect(
      getSatoshiValueResilient({ amount: 10, currency: "usd" })
    ).resolves.toBeNull();
  });
});
