// Local Expo module wrapping Apple's ProximityReaderDiscovery (iOS 18+).
// Swift implementation: ./ios/ProximityReaderDiscoveryModule.swift.
//
// The module is iOS-only (expo-module.config.json), so requireNativeModule
// throws on Android, web, and dev builds that predate it — the require is
// lazy and guarded, and a missing module reads as "unavailable" so callers
// fall back to the custom education screens instead of crashing.

export type ProximityReaderDiscoveryModuleType = {
  // Resolves when Apple's education sheet is dismissed. Rejects on iOS <18,
  // a missing presenter, or any content/presentation error.
  presentEducation(): Promise<void>;
};

let cached: ProximityReaderDiscoveryModuleType | null | undefined;

export function getProximityReaderDiscoveryModule(): ProximityReaderDiscoveryModuleType | null {
  if (cached !== undefined) return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { requireNativeModule } = require("expo-modules-core");
    cached = requireNativeModule(
      "ProximityReaderDiscovery"
    ) as ProximityReaderDiscoveryModuleType;
  } catch {
    cached = null;
  }
  return cached;
}
