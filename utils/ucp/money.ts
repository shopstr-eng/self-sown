import {
  ZERO_DECIMAL_CURRENCIES,
  isSatsCurrency,
} from "@/utils/stripe/currency";

/**
 * Universal Commerce Protocol (UCP) money helper.
 *
 * UCP/agentic clients expect every price as a structured Money object: an
 * integer amount expressed in the currency's *minor units* plus the currency
 * code and the number of decimal places. This module maps a Milk Market price
 * (a plain number + a NIP-99 `currency` tag) onto that shape.
 *
 * IMPORTANT — no FX here. Catalog prices are surfaced in their *native*
 * currency. We deliberately never convert sats↔fiat in this helper: mixing the
 * buyer-facing display FX wrappers (which can return stale/null values) with
 * amounts that look authoritative is exactly the footgun the charge-math path
 * guards against. A bitcoin-priced product is presented as XBT/sats; a USD
 * product as USD. Conversion only ever happens at charge time in the existing
 * order/payment code, which fails closed on a missing rate.
 */

/**
 * Unofficial ISO 4217 code for Bitcoin. Agentic clients require a currency code
 * on every Money object; "XBT" is the widely-recognised code for bitcoin, with
 * the satoshi (1e-8 BTC) as its minor unit (exponent 8).
 */
export const UCP_BITCOIN_CURRENCY = "XBT";

/** Satoshis per whole bitcoin. */
export const SATS_PER_BTC = 100_000_000;

/** Decimal places for bitcoin (1 BTC = 10^8 sats). */
export const BITCOIN_EXPONENT = 8;

export interface UcpMoney {
  /** ISO 4217 currency code, or "XBT" for bitcoin-denominated prices. */
  currency: string;
  /**
   * Integer amount in the currency's minor units (cents for USD, sats for XBT,
   * whole units for zero-decimal currencies like JPY).
   */
  amount: number;
  /** Decimal places: there are 10^exponent minor units per major unit. */
  exponent: number;
  /** Human-readable formatted amount, e.g. "12.00" (USD) or "1500 sat" (XBT). */
  display: string;
}

/** True when the NIP-99 currency tag denotes a bitcoin-denominated price. */
export function isBitcoinCurrency(currency: string): boolean {
  const c = (currency || "").trim().toLowerCase();
  return !c || isSatsCurrency(c) || c === "btc";
}

/**
 * Number of decimal places (minor units per major = 10^exponent) for a
 * NIP-99 currency tag. Bitcoin → 8, zero-decimal fiat → 0, all other fiat → 2.
 */
export function currencyExponent(currency: string): number {
  if (isBitcoinCurrency(currency)) return BITCOIN_EXPONENT;
  if (ZERO_DECIMAL_CURRENCIES.has((currency || "").trim().toLowerCase())) {
    return 0;
  }
  return 2;
}

/**
 * Convert a Milk Market price (plain number) + NIP-99 currency tag into a UCP
 * Money object with the amount in integer minor units. Pure and synchronous —
 * performs no exchange-rate lookups (see the module note). A missing/blank
 * currency is treated as sats, matching the catalog parser's default. Negative
 * or non-finite inputs clamp to 0 so a malformed event can never emit a bogus
 * (e.g. NaN) amount to an agent.
 */
export function toUcpMoney(amount: number, currency: string): UcpMoney {
  const raw = Number(amount);
  const safe = Number.isFinite(raw) && raw > 0 ? raw : 0;
  const cur = (currency || "").trim();
  const lower = cur.toLowerCase();

  if (isBitcoinCurrency(cur)) {
    // A price tagged "btc" is in whole bitcoin; everything else bitcoin-ish
    // (sats/sat/satoshi/blank) is already in satoshis.
    const sats =
      lower === "btc" ? Math.round(safe * SATS_PER_BTC) : Math.round(safe);
    return {
      currency: UCP_BITCOIN_CURRENCY,
      amount: sats,
      exponent: BITCOIN_EXPONENT,
      display: `${sats} sat`,
    };
  }

  const code = cur.toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(lower)) {
    const minor = Math.round(safe);
    return {
      currency: code,
      amount: minor,
      exponent: 0,
      display: String(minor),
    };
  }

  const minor = Math.round(safe * 100);
  return {
    currency: code,
    amount: minor,
    exponent: 2,
    display: (minor / 100).toFixed(2),
  };
}
