# Stripe Terminal location privacy evidence

Verified **2026-11-23** for React Native wrapper **0.0.1-beta.34** and native
iOS SDK **6.0.0**. This is evidence for the prepared App Privacy answers;
no live App Store Connect changes have been made from this workspace.

## SDK-specific primary evidence

The installed wrapper's `stripe-terminal-react-native.podspec` requests
`upToNextMinorVersion`, minimum `6.0.0`, from Stripe's iOS Swift package.
Stripe's [6.0.0 package definition](https://github.com/stripe/stripe-terminal-ios/blob/6.0.0/Package.swift)
identifies the [official release archive](https://github.com/stripe/stripe-terminal-ios/releases/download/6.0.0/StripeTerminal.xcframework.zip).
The downloaded archive's SHA-256 matched that package definition:

```text
90f370b39edee8a45ab50c512d6c054e7d6d3304931a7aeef80916ea97010129
```

Both `ios-arm64/StripeTerminal.framework/PrivacyInfo.xcprivacy` and
`ios-arm64_x86_64-simulator/StripeTerminal.framework/PrivacyInfo.xcprivacy`
inside `StripeTerminal.xcframework` contain these collected-data entries:

| NSPrivacyCollectedDataType | Linked | Tracking | Purposes |
| --- | --- | --- | --- |
| NSPrivacyCollectedDataTypeCoarseLocation | false | false | NSPrivacyCollectedDataTypePurposeAppFunctionality |
| NSPrivacyCollectedDataTypeProductInteraction | false | false | NSPrivacyCollectedDataTypePurposeAnalytics; NSPrivacyCollectedDataTypePurposeAppFunctionality |

There is **no precise-location entry**. These are Stripe's own declarations
of off-device collection, not conclusions drawn from an OS permission.
The native implementation is closed-source; this review does not claim to
have inspected Stripe's servers or measured a deletion deadline.

To reproduce: download the official archive, verify its SHA-256, then read
the two `PrivacyInfo.xcprivacy` files using `unzip -p` or Python's `zipfile`
and `plistlib`. Keep large downloaded SDK archives out of Git. On SDK upgrades,
inspect the actual resolved release and the final archived app's privacy report;
this snapshot is not a claim about all future `6.0.x` releases.

## Collection and purpose

- [Stripe Terminal React Native setup](https://docs.stripe.com/terminal/payments/setup-integration?terminal-sdk-platform=react-native)
  requires location access on iOS. Stripe says it needs to know where payments
  occur to reduce fraud and minimize disputes, and disables payments when it
  cannot determine device location.
- [Stripe Privacy Center: precise location](https://stripe.com/legal/privacy-center#does-stripe-collect-precise-location-data)
  says “Stripe does not collect GPS data from devices and browsers.” It
  describes approximate location, including IP-derived location, for fraud
  detection. Do not infer the Terminal SDK's exact derivation mechanism from
  this general statement; its own manifest supplies the coarse classification.
- [Apple's App Privacy rules](https://developer.apple.com/app-store/app-privacy-details/)
  include integrated third-party SDK collection. Collection means transmitting
  off-device so a developer or partner can access data longer than necessary
  to service the request in real time. Fraud prevention is App Functionality,
  not advertising tracking. Apple explicitly says to declare only Coarse
  Location if precise data is immediately coarsened before storage.

**Answer:** Coarse Location collected, not linked, not tracking, App
Functionality. Precise Location not collected. Also include the manifest's
Product Interaction declaration, not linked, not tracking, App Functionality
and Analytics. Self-sown does not separately collect device coordinates.

## Retention: what is and is not verified

[Stripe's Privacy Center retention table](https://stripe.com/legal/privacy-center#how-long-will-stripe-keep-my-data)
explicitly covers **Geolocation Data (e.g., IP addresses)**. It retains that
category for the duration necessary to comply with law, provide Stripe
services, and pursue legitimate interests including fraud/financial-crime
prevention, legal rights and valid legal process.
[Stripe's Privacy Policy, section 5](https://stripe.com/privacy#5-security-and-retention)
also describes retention beyond a transaction or account closure for legal,
regulatory and financial obligations.

This verifies a declared collected category with purpose-based retention,
**not** a Terminal-location-specific storage duration. The reviewed public
sources provide no such duration and no real-time-only deletion promise.
Do not apply the general “five or more years” business-user statement to each
Terminal location reading, and do not claim readings are immediately discarded.
The policy therefore describes Stripe's retention criteria without inventing
a number of days or years.

## Publication boundary

The prepared entries are in [App Privacy answers](./app-privacy-answers.md);
the public-policy source is `pages/privacy/index.tsx`. Neither changes the live
App Store label. An authorized account holder must enter/publish the answers
in App Store Connect's web UI and retain confirmation. This task does not
publish the website, submit a build, or change an App Store listing.
