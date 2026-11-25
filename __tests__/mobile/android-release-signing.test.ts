const {
  configureAndroidReleaseSigning,
} = require("@/apps/mobile/scripts/configure-android-release-signing.cjs");

const gradleFixture = `android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.debug
            minifyEnabled enableMinifyInReleaseBuilds
        }
    }
}`;

describe("configureAndroidReleaseSigning", () => {
  it("adds env-backed release signing and uses it for release builds", () => {
    const configured = configureAndroidReleaseSigning(gradleFixture);
    expect(configured).toContain(
      'storeFile file(System.getenv("ANDROID_KEYSTORE_FILE"))'
    );
    expect(configured).toContain("signingConfig signingConfigs.release");
    expect(configured).not.toContain(
      "signingConfig signingConfigs.debug\n            minifyEnabled"
    );
  });

  it("is idempotent", () => {
    const configured = configureAndroidReleaseSigning(gradleFixture);
    expect(configureAndroidReleaseSigning(configured)).toBe(configured);
  });

  it("fails if the generated Expo template no longer matches", () => {
    expect(() =>
      configureAndroidReleaseSigning(
        gradleFixture.replace("signingConfig signingConfigs.debug", "")
      )
    ).toThrow(/Expected one debug signingConfig/);
  });
});
