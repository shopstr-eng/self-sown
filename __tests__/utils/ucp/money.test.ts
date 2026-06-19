/** @jest-environment node */

// Unit coverage for the UCP money helper (utils/ucp/money.ts). This decides how
// every catalog/checkout price is presented to shopping agents as a structured
// Money object (minor units + exponent), so a regression here would mis-state
// prices to agents. The helper is deliberately pure and does NO FX.

import {
  toUcpMoney,
  isBitcoinCurrency,
  currencyExponent,
  UCP_BITCOIN_CURRENCY,
  SATS_PER_BTC,
  BITCOIN_EXPONENT,
} from "@/utils/ucp/money";

describe("toUcpMoney", () => {
  it("converts standard fiat to minor units (2 decimals)", () => {
    expect(toUcpMoney(12, "USD")).toEqual({
      currency: "USD",
      amount: 1200,
      exponent: 2,
      display: "12.00",
    });
  });

  it("uppercases the currency code and rounds cents", () => {
    expect(toUcpMoney(12.5, "usd")).toEqual({
      currency: "USD",
      amount: 1250,
      exponent: 2,
      display: "12.50",
    });
    // 19.99 * 100 has a floating-point tail; must round to a clean integer.
    expect(toUcpMoney(19.99, "eur").amount).toBe(1999);
  });

  it("treats zero-decimal currencies as whole units", () => {
    expect(toUcpMoney(1000, "JPY")).toEqual({
      currency: "JPY",
      amount: 1000,
      exponent: 0,
      display: "1000",
    });
  });

  it("maps sats to XBT with exponent 8", () => {
    expect(toUcpMoney(1500, "sats")).toEqual({
      currency: UCP_BITCOIN_CURRENCY,
      amount: 1500,
      exponent: BITCOIN_EXPONENT,
      display: "1500 sat",
    });
  });

  it("treats a blank currency as sats (catalog parser default)", () => {
    const m = toUcpMoney(2100, "");
    expect(m.currency).toBe(UCP_BITCOIN_CURRENCY);
    expect(m.amount).toBe(2100);
    expect(m.exponent).toBe(8);
  });

  it("converts whole-bitcoin prices to sats", () => {
    const m = toUcpMoney(0.5, "btc");
    expect(m.currency).toBe(UCP_BITCOIN_CURRENCY);
    expect(m.amount).toBe(SATS_PER_BTC / 2);
    expect(m.display).toBe(`${SATS_PER_BTC / 2} sat`);
  });

  it("clamps negative and non-finite inputs to 0", () => {
    expect(toUcpMoney(-5, "USD").amount).toBe(0);
    expect(toUcpMoney(NaN, "USD").amount).toBe(0);
    expect(toUcpMoney(Infinity, "sats").amount).toBe(0);
  });
});

describe("isBitcoinCurrency", () => {
  it("treats sats/sat/satoshi/btc/blank as bitcoin", () => {
    for (const c of ["sats", "sat", "satoshi", "btc", "BTC", ""]) {
      expect(isBitcoinCurrency(c)).toBe(true);
    }
  });

  it("treats fiat as non-bitcoin", () => {
    for (const c of ["usd", "USD", "eur", "jpy"]) {
      expect(isBitcoinCurrency(c)).toBe(false);
    }
  });
});

describe("currencyExponent", () => {
  it("returns 8 for bitcoin, 0 for zero-decimal fiat, 2 otherwise", () => {
    expect(currencyExponent("sats")).toBe(8);
    expect(currencyExponent("")).toBe(8);
    expect(currencyExponent("JPY")).toBe(0);
    expect(currencyExponent("USD")).toBe(2);
    expect(currencyExponent("eur")).toBe(2);
  });
});
