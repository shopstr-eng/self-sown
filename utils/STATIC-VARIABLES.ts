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

export type ShippingOptionsType =
  | "Pickup"
  | "Free"
  | "Added Cost"
  | "Free/Pickup"
  | "Added Cost/Pickup"
  | "N/A";

export const SHIPPING_OPTIONS = [
  "Pickup",
  "Free",
  "Added Cost",
  "Free/Pickup",
  "Added Cost/Pickup",
  "N/A",
];

// Base styles for all neo-brutalist buttons with slight rounded corners
const NEO_BUTTON_BASE =
  "px-4 py-2 border-2 border-black font-bold shadow-neo hover:-translate-y-0.5 active:translate-y-0.5 transform transition-transform rounded-md";

export const BLACKBUTTONCLASSNAMES = `${NEO_BUTTON_BASE} bg-black text-white`;

export const WHITEBUTTONCLASSNAMES = `${NEO_BUTTON_BASE} bg-white text-black`;

export const PRIMARYBUTTONCLASSNAMES = `${NEO_BUTTON_BASE} bg-primary-yellow text-black`;

export const BLUEBUTTONCLASSNAMES = `${NEO_BUTTON_BASE} bg-primary-blue text-white`;

export const DANGERBUTTONCLASSNAMES = `${NEO_BUTTON_BASE} bg-red-500 text-white`;

export const PREVNEXTBUTTONSTYLES =
  "absolute top-1/2 -translate-y-1/2 z-10 p-2 bg-white border-2 border-black rounded-md shadow-neo hover:-translate-y-1/2 hover:scale-105 active:scale-100 transform transition-transform";
