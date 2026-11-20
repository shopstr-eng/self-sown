# App Store submission gate (Tap to Pay entitlement)

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
