/**
 * Countries where sellers can open a Stripe Connect Express account through a
 * US-based platform, plus the subdivisions Stripe Tax needs for the two
 * countries that register per-region instead of per-country.
 *
 * Used by BOTH the account-creation API (validation) and the seller-facing
 * payment settings UI (dropdowns), so it must stay client-safe (no Node deps).
 */

export interface ConnectCountry {
  code: string; // ISO 3166-1 alpha-2
  name: string;
}

export const STRIPE_CONNECT_COUNTRIES: ConnectCountry[] = [
  { code: "US", name: "United States" },
  { code: "GB", name: "United Kingdom" },
  { code: "IE", name: "Ireland" },
  { code: "AT", name: "Austria" },
  { code: "BE", name: "Belgium" },
  { code: "BG", name: "Bulgaria" },
  { code: "HR", name: "Croatia" },
  { code: "CY", name: "Cyprus" },
  { code: "CZ", name: "Czechia" },
  { code: "DK", name: "Denmark" },
  { code: "EE", name: "Estonia" },
  { code: "FI", name: "Finland" },
  { code: "FR", name: "France" },
  { code: "DE", name: "Germany" },
  { code: "GR", name: "Greece" },
  { code: "HU", name: "Hungary" },
  { code: "IT", name: "Italy" },
  { code: "LV", name: "Latvia" },
  { code: "LT", name: "Lithuania" },
  { code: "LU", name: "Luxembourg" },
  { code: "MT", name: "Malta" },
  { code: "NL", name: "Netherlands" },
  { code: "PL", name: "Poland" },
  { code: "PT", name: "Portugal" },
  { code: "RO", name: "Romania" },
  { code: "SK", name: "Slovakia" },
  { code: "SI", name: "Slovenia" },
  { code: "ES", name: "Spain" },
  { code: "SE", name: "Sweden" },
  { code: "NO", name: "Norway" },
  { code: "CH", name: "Switzerland" },
  { code: "CA", name: "Canada" },
  { code: "AU", name: "Australia" },
  { code: "NZ", name: "New Zealand" },
  { code: "JP", name: "Japan" },
  { code: "SG", name: "Singapore" },
  { code: "HK", name: "Hong Kong" },
  { code: "MX", name: "Mexico" },
];

export const STRIPE_CONNECT_COUNTRY_CODES = new Set(
  STRIPE_CONNECT_COUNTRIES.map((c) => c.code)
);

export const isStripeConnectCountry = (code: string): boolean =>
  STRIPE_CONNECT_COUNTRY_CODES.has(code.toUpperCase());

/**
 * Countries whose tax registrations are per-subdivision rather than
 * whole-country. US registers per state (state_sales_tax), Canada per
 * province (province_standard). Every other supported country registers at
 * the country level (standard / VAT).
 */
export const COUNTRIES_WITH_REGIONAL_TAX = new Set(["US", "CA"]);

export const US_STATE_CODES = new Set([
  "AL",
  "AK",
  "AZ",
  "AR",
  "CA",
  "CO",
  "CT",
  "DE",
  "DC",
  "FL",
  "GA",
  "HI",
  "ID",
  "IL",
  "IN",
  "IA",
  "KS",
  "KY",
  "LA",
  "ME",
  "MD",
  "MA",
  "MI",
  "MN",
  "MS",
  "MO",
  "MT",
  "NE",
  "NV",
  "NH",
  "NJ",
  "NM",
  "NY",
  "NC",
  "ND",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VT",
  "VA",
  "WA",
  "WV",
  "WI",
  "WY",
]);

export const CA_PROVINCE_CODES = new Set([
  "AB",
  "BC",
  "MB",
  "NB",
  "NL",
  "NT",
  "NS",
  "NU",
  "ON",
  "PE",
  "QC",
  "SK",
  "YT",
]);

/** Validate a region (state/province) code for a regional-tax country. */
export const isValidTaxRegion = (country: string, region: string): boolean => {
  const r = region.toUpperCase();
  switch (country.toUpperCase()) {
    case "US":
      return US_STATE_CODES.has(r);
    case "CA":
      return CA_PROVINCE_CODES.has(r);
    default:
      return false;
  }
};
