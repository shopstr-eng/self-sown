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
  version: "0.4.0",
  orientation: "portrait",
  scheme: ["selfsown", "milkmarket"],
  userInterfaceStyle: "automatic",
  icon: "./assets/icon.png",
  plugins: [
    "expo-router",
    // Pins the Kotlin Gradle Plugin version (the compiler itself) — the
    // android.kotlinVersion gradle property above does not reach it.
    "./plugins/with-android-kotlin-version.js",
    [
      "expo-dev-client",
      {
        launchMode: "most-recent",
      },
    ],
    // @stripe/stripe-terminal-react-native's podspec declares ios: '16.0';
    // without this the EAS pod install fails with "Some pods require a
    // higher minimum deployment target".
    [
      "expo-build-properties",
      {
        android: {
          // Stripe Terminal Android SDK 6.x resolves kotlin-stdlib 2.3.21;
          // compiling with an older Kotlin dies on "incompatible version of
          // Kotlin" metadata in :stripe_stripe-terminal-react-native.
          // Must be a version BOTH KSP and the Compose plugin publish:
          // KSP has 2.3.0/2.3.1, Compose has 2.3.0/2.3.10/2.3.20/2.3.21.
          kotlinVersion: "2.3.0",
        },
        ios: {
          deploymentTarget: "16.0",
        },
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
    // Universal links: the account-recovery email link
    // (https://self-sown.com/auth/recover?token=...) opens straight into the
    // app when installed. Requires the AASA file served at
    // /.well-known/apple-app-site-association on the platform host.
    associatedDomains: ["applinks:self-sown.com"],
    entitlements: {
      // Tap to Pay on iPhone — granted by Apple WITH the development
      // distribution restriction: registered test devices only until the
      // publishing entitlement is approved. Requires the Tap to Pay
      // capability enabled on the App ID in the Apple Developer portal
      // (EAS regenerates provisioning profiles on the next build).
      "com.apple.developer.proximity-reader.payment.acceptance": true,
    },
    infoPlist: {
      NSPhotoLibraryUsageDescription:
        "Self-sown needs access to your photo library so you can attach product photos to your listings.",
      NSCameraUsageDescription:
        "Self-sown needs camera access so you can photograph products for your listings.",
      // Stripe Terminal (in-person PoS card payments). Tap to Pay on iPhone
      // additionally requires Apple's proximity-reader entitlement, which is
      // granted per-developer-account — add it to entitlements once approved.
      NSBluetoothAlwaysUsageDescription:
        "Self-sown uses Bluetooth to connect to nearby card readers for in-person payments.",
      NSBluetoothPeripheralUsageDescription:
        "Self-sown uses Bluetooth to connect to nearby card readers for in-person payments.",
      NSLocationWhenInUseUsageDescription:
        "Self-sown uses your location to connect to card readers for in-person payments.",
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: bundleId,
    // Android App Links counterpart to the iOS associatedDomains entry;
    // autoVerify checks the assetlinks.json served on the platform host.
    intentFilters: [
      {
        action: "VIEW",
        autoVerify: true,
        data: [
          {
            scheme: "https",
            host: "self-sown.com",
            pathPrefix: "/auth/recover",
          },
        ],
        category: ["BROWSABLE", "DEFAULT"],
      },
    ],
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      backgroundColor: "#0D4B3E",
    },
    // Stripe Terminal (in-person PoS): NFC for Tap to Pay on Android,
    // bluetooth + location for external card readers.
    permissions: [
      "android.permission.NFC",
      "android.permission.BLUETOOTH_CONNECT",
      "android.permission.BLUETOOTH_SCAN",
      "android.permission.ACCESS_FINE_LOCATION",
    ],
    ...(process.env.GOOGLE_SERVICES_JSON
      ? { googleServicesFile: process.env.GOOGLE_SERVICES_JSON }
      : {}),
  },
  web: {
    bundler: "metro",
  },
};

export default config;
