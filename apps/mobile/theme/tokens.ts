// Earth-tone brand palette with neo-brutalist geometry — the mobile app's
// warm cream/terracotta colors dressed in the web's design language: 2px
// black borders, hard offset shadows, sharp 6px corners, bold type.
export const sellerThemeTokens = {
  background: "#F4F1E8",
  surface: "#FFFFFF",
  text: "#17231E",
  mutedText: "#4F5C56",
  primary: "#0D4B3E",
  black: "#000000",
  border: "#000000",
  accent: "#C96442",
  success: "#2C7A57",
  danger: "#B3453B",
  warning: "#A36A12",
  subduedSurface: "#EEE6D6",
};

// Poppins families loaded via expo-font in app/_layout.tsx. Android ignores
// fontWeight for custom fonts, so each weight needs its explicit family.
export const sellerFonts = {
  regular: "Poppins_400Regular",
  semibold: "Poppins_600SemiBold",
  bold: "Poppins_700Bold",
  extrabold: "Poppins_800ExtraBold",
} as const;

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
