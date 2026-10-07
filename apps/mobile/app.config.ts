// Plain JavaScript only: the EAS build worker evaluates this config WITHOUT a
// TypeScript transpiler, so TS-only syntax (import type, annotations, casts)
// fails the cloud build at READ_APP_CONFIG. JSDoc carries the types.
// The shared validator lives in lib/api-configuration.js — plain CommonJS for
// the same reason (a .ts or ESM import would not load on the worker).
import { resolveMobileApiBaseUrl } from "./lib/api-configuration.js";

const variant = process.env.MOBILE_APP_VARIANT ?? "development";
const release = variant === "staging" || variant === "production";
const projectId = process.env.EAS_PROJECT_ID;
if (release) {
  resolveMobileApiBaseUrl(process.env.EXPO_PUBLIC_API_BASE_URL, "ios", false);
  if (
    !projectId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      projectId
    )
  )
    throw new Error("Configure EAS_PROJECT_ID for this build.");
}
const bundleId =
  variant === "staging" ? "com.selfsown.mobile.staging" : "com.selfsown.mobile";
/** @type {import("expo/config").ExpoConfig} */
const config = {
  name: variant === "staging" ? "Self-sown Staging" : "Self-sown Vendor",
  owner: "shopstr-markets",
  extra: { ...(projectId ? { eas: { projectId } } : {}), appVariant: variant },
  slug: "self-sown-mobile",
  version: "0.1.0",
  orientation: "portrait",
  scheme: ["selfsown", "milkmarket"],
  userInterfaceStyle: "automatic",
  icon: "./assets/icon.png",
  plugins: [
    "expo-router",
    [
      "expo-dev-client",
      {
        launchMode: "most-recent",
      },
    ],
    "expo-secure-store",
    [
      "expo-notifications",
      {
        defaultChannel: "seller-activity",
        enableBackgroundRemoteNotifications: true,
      },
    ],
    "expo-web-browser",
    [
      "expo-splash-screen",
      {
        image: "./assets/splash-icon.png",
        imageWidth: 200,
        resizeMode: "contain",
        backgroundColor: "#0D4B3E",
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
  },
  ios: {
    supportsTablet: true,
    bundleIdentifier: bundleId,
    infoPlist: {
      NSPhotoLibraryUsageDescription:
        "Self-sown needs access to your photo library so you can attach product photos to your listings.",
      NSCameraUsageDescription:
        "Self-sown needs camera access so you can photograph products for your listings.",
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: bundleId,
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      backgroundColor: "#0D4B3E",
    },
    ...(process.env.GOOGLE_SERVICES_JSON
      ? { googleServicesFile: process.env.GOOGLE_SERVICES_JSON }
      : {}),
  },
  web: {
    bundler: "metro",
  },
};

export default config;
