// Neo-brutalist brand palette — mirrors the web app's tailwind.config.ts
// (primary-yellow / primary-green / black / white) so seller-facing screens
// share the site's design language: white surfaces, 2px black borders,
// hard offset shadows, yellow primary actions, deep-green accents.
export const sellerThemeTokens = {
  background: "#FFFFFF",
  surface: "#FFFFFF",
  text: "#000000",
  mutedText: "#525252",
  primary: "#0D4B3E",
  yellow: "#FFD23F",
  black: "#000000",
  border: "#000000",
  accent: "#FFD23F",
  success: "#166534",
  danger: "#B91C1C",
  warning: "#A36A12",
  subduedSurface: "#F5F5F5",
};

// Web shadow-neo equivalent: 4px 4px 0 #000. Android elevation can only
// approximate a hard offset shadow; iOS renders it exactly.
export const neoShadow = {
  shadowColor: "#000000",
  shadowOffset: { width: 4, height: 4 },
  shadowOpacity: 1,
  shadowRadius: 0,
  elevation: 5,
} as const;

export const neoShadowPressed = {
  shadowOffset: { width: 1, height: 1 },
  elevation: 1,
} as const;
