import type { ExpoConfig } from "expo/config";

const config: ExpoConfig = {
  name: "Self-sown Vendor",
  slug: "self-sown-mobile",
  version: "0.1.0",
  orientation: "portrait",
  scheme: ["selfsown", "milkmarket"],
  userInterfaceStyle: "automatic",
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
  ],
  experiments: {
    typedRoutes: true,
  },
  ios: {
    supportsTablet: true,
    bundleIdentifier: "com.selfsown.mobile",
  },
  android: {
    package: "com.selfsown.mobile",
  },
  web: {
    bundler: "metro",
  },
};

export default config;
