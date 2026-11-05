---
name: Android Kotlin version pin (Stripe Terminal)
description: EAS Android builds fail on Kotlin metadata mismatch unless kotlinVersion is pinned to what the Stripe Terminal SDK ships; how to diagnose and fix.
---

EAS Android builds (Nov 2026) failed in `:stripe_stripe-terminal-react-native:compileReleaseKotlin` with "Module was compiled with an incompatible version of Kotlin" — the Stripe Terminal Android SDK 6.x resolves kotlin-stdlib 2.3.21, but the root project's Kotlin compiler was older (RN 0.83 template default). The package's build.gradle reads `rootProject.ext.kotlinVersion` first, so the app-level version wins over the package default.

**Why:** Stripe bumps the Kotlin metadata version in their Android SDK faster than the Expo/RN template's default Kotlin; the mismatch only shows at cloud-build time (JS-only local dev never compiles the module).

**How to apply:** If an Android EAS build fails with Kotlin metadata/incompatible-class errors, pin `android.kotlinVersion` via expo-build-properties in apps/mobile/app.config.ts to the kotlin-stdlib version named in the error (currently 2.3.21). Verify locally with `env -u GOOGLE_SERVICES_JSON npx expo prebuild -p android --no-install` then check `android/gradle.properties` for `android.kotlinVersion=<pin>` (the generated `android/` dir is gitignored — delete after). GOOGLE_SERVICES_JSON must be unset for local prebuild: on EAS it's a file path, but locally the env var holds the raw JSON, and the config plugin tries to open the JSON text as a filename (ENAMETOOLONG).

Log-reading gotcha: `eas build:view <id> --json` logFiles URLs are brotli-compressed (`content-encoding: br`) — plain urllib/fetch returns garbage; use `curl --compressed`.
