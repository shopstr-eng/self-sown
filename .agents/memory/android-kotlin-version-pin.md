---
name: Android Kotlin version pin (Stripe Terminal)
description: EAS Android builds fail on Kotlin metadata mismatch unless the Kotlin Gradle Plugin (compiler) is pinned via config plugin; the expo-build-properties gradle property alone does NOT reach the compiler.
---

EAS Android builds (Nov 2026) failed in `:stripe_stripe-terminal-react-native:compileReleaseKotlin` with "incompatible version of Kotlin" — the Stripe Terminal Android SDK 6.x ships classes with Kotlin 2.3 metadata, but the compiler stayed at 2.1.x.

**Why:** The Expo template's generated `android/build.gradle` declares `classpath('org.jetbrains.kotlin:kotlin-gradle-plugin')` VERSIONLESS, so the compiler resolves transitively from React Native's version catalog and ignores everything else. The `android.kotlinVersion` property (set via expo-build-properties) only steers the stdlib/KSP/Compose artifacts — pinning it alone produces a new failure: stdlib 2.3.x on the classpath but compiler still 2.1.x ("binary version of its metadata is 2.3.0, expected version is 2.1.0" in some OTHER module like safe-area-context).

**How to apply:** Two coordinated pins, both required (see apps/mobile):
1. `plugins/with-android-kotlin-version.js` config plugin rewrites the versionless classpath to an explicit version in the generated build.gradle (verified via local prebuild + grep of android/build.gradle).
2. expo-build-properties `android.kotlinVersion` matches it for stdlib/KSP/Compose.

The version must exist in THREE artifact sets at once: Kotlin compiler, KSP ("Can't find KSP version..." lists its set), AND the Compose compiler plugin (org.jetbrains.kotlin.plugin.compose — patch sets differ, e.g. no 2.3.1). Intersection in Nov 2026: **2.3.0**. Check both maven-metadata.xml files before burning a cloud build.

Also from the same SDK drift: stripe-terminal-react-native beta.34 declares minSdk 26 in its library manifest, so the app manifest merger fails against the default 24. Fix via expo-build-properties `android.minSdkVersion: 26` (lands as android.minSdkVersion in gradle.properties) — never tools:overrideLibrary it; the SDK uses API-26 symbols at runtime.

Other gotchas: local `expo prebuild` needs GOOGLE_SERVICES_JSON unset (on EAS it's a file path; locally the env var holds raw JSON → ENAMETOOLONG). `eas build:view --json` logFiles URLs are brotli-compressed (`content-encoding: br`) — use `curl --compressed`, then parse NDJSON lines' .msg field; the "unknown error" summary is useless, grep the RUN_GRADLEW phase tail for FAILURE.
