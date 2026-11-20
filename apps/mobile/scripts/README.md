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
