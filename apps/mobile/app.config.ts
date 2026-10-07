import type { ExpoConfig } from "expo/config";
// Expo evaluates this config in Node; the explicit extension allows Node 22
// to load the shared, dependency-free TypeScript validator.
const { resolveMobileApiBaseUrl } =
  require("./lib/api-configuration.ts") as typeof import("./lib/api-configuration");

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
  variant === "staging"
    ? "com.selfsown.mobile.staging"
    : "com.selfsown.mobile";
const config: ExpoConfig = {
  name: variant === "staging" ? "Self-sown Staging" : "Self-sown Vendor",
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
