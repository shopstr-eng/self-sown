import type { ExpoConfig } from "expo/config";

const config: ExpoConfig = {
  name: "Self-sown Vendor",
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
    bundleIdentifier: "com.self-sown.mobile",
    infoPlist: {
      NSPhotoLibraryUsageDescription:
        "Self-sown needs access to your photo library so you can attach product photos to your listings.",
      NSCameraUsageDescription:
        "Self-sown needs camera access so you can photograph products for your listings.",
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: "com.selfsown.mobile",
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      backgroundColor: "#0D4B3E",
    },
  },
  web: {
    bundler: "metro",
  },
};

export default config;
