import { Platform } from "react-native";

// Stripe Terminal (Tap to Pay) is a native-only module: it is absent from the
// web export and from dev clients built before the dependency landed. Every
// consumer must go through getStripeTerminalModule() — a direct static import
// would crash those builds at bundle time.
type StripeTerminalModule =
  typeof import("@stripe/stripe-terminal-react-native");

let cached: StripeTerminalModule | null | undefined;

export function getStripeTerminalModule(): StripeTerminalModule | null {
  if (cached !== undefined) return cached;
  if (Platform.OS === "web") {
    cached = null;
    return cached;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cached = require("@stripe/stripe-terminal-react-native") as StripeTerminalModule;
  } catch {
    cached = null;
  }
  return cached;
}

export function isStripeTerminalAvailable(): boolean {
  return getStripeTerminalModule() !== null;
}
