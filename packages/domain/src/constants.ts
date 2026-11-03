export const CATEGORIES = [
  "Milk",
  "Cheese",
  "Beef",
  "Eggs",
  "Yogurt",
  "Butter",
  "Ghee",
  "Cream",
  "Pets",
  "Health",
  "Food",
  "Cow",
  "Goat",
  "Herdshare",
  "Bundle",
];

// The platform default Cashu mint: fresh sellers get Lightning payments out
// of the box (funds land as ecash at this mint, claimable into the wallet).
// The server mint allowlist and the mobile account preferences both source
// the default from here so the two can never drift.
export const DEFAULT_CASHU_MINT_URL = "https://mint.minibits.cash/Bitcoin";

export type ShippingOptionsType =
  | "Pickup"
  | "Free"
  | "Added Cost"
  | "Free/Pickup"
  | "Added Cost/Pickup"
  | "N/A";

export const SHIPPING_OPTIONS: ShippingOptionsType[] = [
  "Pickup",
  "Free",
  "Added Cost",
  "Free/Pickup",
  "Added Cost/Pickup",
  "N/A",
];
