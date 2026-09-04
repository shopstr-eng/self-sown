// ISO 3166-1 alpha-2 ship-to country validation, sourced from the same
// public/locationSelection.json the checkout country dropdown renders — one
// list shared by picker and validators so they can't drift.
import locationSelection from "../../public/locationSelection.json";

export const ISO_COUNTRY_CODES: ReadonlySet<string> = new Set(
  locationSelection.countries.map((c: { iso3166: string }) =>
    c.iso3166.toUpperCase()
  )
);

// Validate + normalize raw ship-to country inputs (form multi-select arrays,
// MCP string arrays, comma-joined strings, or raw Nostr tag values): trim,
// uppercase, keep only known ISO 3166-1 alpha-2 codes, dedup, and sort for a
// deterministic tag order. Unknown codes are dropped — never fabricated into.
export function parseShipsToCodes(values: string[]): string[] {
  const codes = new Set<string>();
  for (const value of values) {
    const code = String(value).trim().toUpperCase();
    if (ISO_COUNTRY_CODES.has(code)) codes.add(code);
  }
  return [...codes].sort();
}
