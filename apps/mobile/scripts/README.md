# App Store submission gate (Tap to Pay entitlement)

## Xcode 27 preparation

Production iOS uses the named EAS image `macos-tahoe-26.6-xcode-27.2`,
not the moving `latest` alias. Expo SDK 57.0.34 and its matching native
dependencies enable the supported UIKit scene migration through
`expo-build-properties` (`ios.enableSceneSupport: true`). The minimum iOS
version is now 16.4. Do not remove scene support while building with Xcode 27:
the app must use it to launch on iOS 27.

Local verification:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @self-sown/mobile typecheck
pnpm test:mobile
cd apps/mobile
pnpm exec expo install --check
pnpm exec expo prebuild --platform ios --no-install
pnpm exec expo export --platform ios --platform android \
  --output-dir ../../generated-artifacts/xcode27-bundles
```

Prebuild generates ignored native directories; do not commit them. On Linux
this verifies project generation, **not** compilation, signing, or device launch.
The older Metro 0.83 image-size patches were removed because Metro 0.84 consumes
asset buffers directly; retain the patched `image-size` override.

**Validation upload outstanding:** no Xcode 27 IPA has been built or uploaded
as part of this preparation. This change is not evidence that Apple's SDK
requirement has been met. After merge, and once the existing release hold is
cleared, the release operator must:

1. Build with `eas build --platform ios --profile production` from this
   directory, using the existing local distribution credentials. Do not use the
   development-certificate swap script.
2. Record the EAS build ID and confirm the build logs show Xcode 27.2.
   Inspect the IPA's `DTXcode`, `DTSDKName`, and `MinimumOSVersion` to confirm
   the actual artifact uses Xcode 27+, the iOS 27+ SDK, and the expected minimum.
3. Check launch on iOS 27, account-recovery links, notification handling, and
   Tap to Pay on a real supported device.
4. Submit the **specific build**, using `submit:ios --build <eas-build-id>`
   below. Keep the entitlement gate; do not use bare `eas submit`.
5. Confirm App Store Connect finishes processing successfully and record the
   build number and upload date before the planned April 2027 deadline.
   Uploading for validation does not authorize an App Review or public release.

Sources: [Expo build images](https://docs.expo.dev/build-reference/infrastructure/),
[scene migration](https://docs.expo.dev/versions/v57.0.0/sdk/build-properties/).

## Entitlement check

The Tap to Pay entitlement (`com.apple.developer.proximity-reader.payment.acceptance`)
can silently disappear from a built IPA's `embedded.mobileprovision` — a fresh
provisioning profile created after the capability is enabled can omit it, and the
capability is not toggleable through the ASC API. A build that lost it still signs
and uploads, and only fails later in App Review.

To stop that, **submit App Store builds through the wrapper**, never a bare
`eas submit`:

```sh
# latest finished iOS production build on EAS
pnpm --filter @self-sown/mobile submit:ios --latest

# a specific EAS build id
pnpm --filter @self-sown/mobile submit:ios --build <eas-build-id>

# an IPA already on disk
pnpm --filter @self-sown/mobile submit:ios --path ./SelfsownVendor.ipa
```

(`--` before the flags is also accepted, for shells/pnpm versions that need it.)

`submit-ios.mjs` resolves the IPA, runs `verify-ios-entitlements.mjs` on it, and
only calls `eas submit` when the profile is clean. On failure it exits non-zero
and prints what is missing — nothing reaches Apple.

## Running the check alone

```sh
pnpm --filter @self-sown/mobile verify:ios-entitlements -- <path.ipa | path.app | path.mobileprovision>
```

It asserts both App Store signing invariants and fails loudly if either is off:

1. `com.apple.developer.proximity-reader.payment.acceptance` = `true`
2. `aps-environment` = `production`

Requires `unzip` and `openssl` (both standard on Linux/macOS).

# App Store submission helper

`appstore-submission.mjs` performs the API half of finishing the App Store
listing — reporting what a version still needs, uploading the required
screenshots, attaching the Tap to Pay walkthrough video, and submitting for
review. The steps that need a human (device screenshots, App Privacy in the web
UI, filming the tap walkthrough) are documented in `docs/apple-review/README.md`.

```sh
# what does version 1.0 still need? (reuses the app's draft submission)
pnpm --filter @self-sown/mobile appstore:status

# upload iPhone 6.9" + iPad 13" screenshots (dimensions are validated)
pnpm --filter @self-sown/mobile appstore:screenshots -- --dir ./appstore-screenshots [--replace]

# attach the walkthrough video to App Review information
pnpm --filter @self-sown/mobile appstore:attachment -- --file ./tap-walkthrough.mp4

# submit (aborts if Apple still reports blockers)
pnpm --filter @self-sown/mobile appstore:submit -- --version 1.0
```

It authenticates with the same ES256 key as `provision-ios-credentials.mjs`
(`APP_STORE_CONNECT_KEY_ID` / `APP_STORE_CONNECT_ISSUER_ID` + `asc-key.p8`), and
normalizes a key that arrived newline-collapsed from a secret.

# App Store listing

`appstore-listing.mjs` holds the canonical listing copy (name, subtitle,
description, keywords, support/marketing URLs, copyright, primary category,
content rights, age rating and price) and the App Store Connect calls to apply
it. The listing was originally filled with one-off API calls; this makes it
repeatable so it does not drift on the next version bump or app re-create. See
`docs/app-store-listing.md` for the recorded values.

```sh
# report how the live listing differs from the canonical copy (exit 1 on drift)
pnpm --filter @self-sown/mobile appstore:listing:check

# write the canonical values; run this after cutting a new version
pnpm --filter @self-sown/mobile appstore:listing:apply
```

Both accept `--app <id>`, `--version <x>` and `--locale <l>`. `apply` only writes
fields that differ, and creates the app-info or version localization when it is
missing, so it fills a fresh version's empty localization in one shot.

## Android release artifacts

The GitHub Actions workflow `Android release artifacts` builds a signed Android
App Bundle (`.aab`) for Google Play and a signed APK (`.apk`) for Zapstore. It
only creates downloadable artifacts; it does not upload either file to a store.
Run it manually from the repository's `main` branch and enter an Android
`versionCode` higher than the highest one already uploaded to Google Play.

Before running it, add these GitHub Actions repository secrets. Use the same
existing Android upload keystore that is registered with the Play app-signing
setup; never commit it or paste its contents into chat.

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`
- `GOOGLE_SERVICES_JSON` (the Firebase app configuration JSON)

The workflow validates the keystore and the signatures on both outputs. Download
the AAB for Play Console and the APK for Zapstore from the completed workflow's
artifacts. A failed workflow does not publish anything.
