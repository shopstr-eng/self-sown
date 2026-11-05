// Plain JavaScript: EAS build workers evaluate config plugins without a TS
// transpiler (same constraint as app.config.ts).
//
// The Expo template declares the Kotlin Gradle Plugin on the root buildscript
// classpath WITHOUT a version, so it resolves transitively from React Native's
// version catalog (2.1.20) and never sees the android.kotlinVersion gradle
// property — that property only steers the stdlib/KSP/Compose artifacts.
// Stripe Terminal Android SDK 6.x ships classes compiled with Kotlin 2.3
// metadata, so the compiler itself must be 2.3.x. Pin 2.3.0: the newest 2.3.x
// published by BOTH KSP and the Compose compiler plugin (2.3.1 has no Compose
// artifact, 2.3.21 has no KSP artifact).
const { withProjectBuildGradle } = require("expo/config-plugins");

const KOTLIN_VERSION = "2.3.0";

module.exports = function withAndroidKotlinVersion(config) {
  return withProjectBuildGradle(config, (mod) => {
    const contents = mod.modResults.contents;
    const versionless = "classpath('org.jetbrains.kotlin:kotlin-gradle-plugin')";
    if (!contents.includes(versionless)) {
      throw new Error(
        "with-android-kotlin-version: versionless kotlin-gradle-plugin classpath not found in android/build.gradle — Expo template changed?"
      );
    }
    mod.modResults.contents = contents.replace(
      versionless,
      `classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:${KOTLIN_VERSION}")`
    );
    return mod;
  });
};
