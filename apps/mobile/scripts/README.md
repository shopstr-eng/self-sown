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
