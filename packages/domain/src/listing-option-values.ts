// Website product-form choices. Keep labels unchanged: tags use these as identifiers.
export const SELLER_SIZE_VALUES = ["XS", "SM", "MD", "LG", "XL", "XXL"];
export const SELLER_VOLUME_VALUES = [
  "Half-pint",
  "Pint",
  "Quart",
  "Half-gallon",
  "Gallon",
];
export const SELLER_WEIGHT_VALUES = [
  ...Array.from({ length: 16 }, (_, i) => `${i + 1}oz`),
  "1lbs",
];
export function sellerPriceDecimals(currency: string): number {
  const code = currency.trim().toLowerCase();
  return code === "sat" || code === "sats" ? 0 : code === "btc" ? 8 : 2;
}
export function isSellerDecimal(value: string, decimals = 8): boolean {
  const input = value.trim();
  return (
    /^\d+(?:\.\d+)?$/.test(input) &&
    Number.isFinite(Number(input)) &&
    Number(input) <= Number.MAX_SAFE_INTEGER &&
    (input.split(".")[1]?.length ?? 0) <= decimals
  );
}
export function isSellerQuantity(value: string): boolean {
  return /^\d+$/.test(value.trim()) && Number(value) <= 2147483647;
}
