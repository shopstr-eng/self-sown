# Stripe Terminal Android location evidence

Reviewed **2026-11-24**. This is Android evidence, not an application of the
iOS privacy manifest. Prepared Play answers: [payment location Data safety](./google-play-payment-location-data-safety.md).

## Resolved SDK and release artifacts

`apps/mobile/package.json` and `pnpm-lock.yaml` pin
`@stripe/stripe-terminal-react-native` to **0.0.1-beta.34**. Its installed
`android/gradle.properties` sets
`StripeTerminalReactNative_terminalSdkVersion=6.0.0` and
`StripeTerminalReactNative_taptopay.enabled=true`. Its `android/build.gradle`
uses that version for `stripeterminal-core`, `stripeterminal-taptopay`, and
`stripeterminal-appsondevices`. No project `terminalSdkVersion` override was
found in the mobile config/plugins or patches. This establishes the native
dependency selected by the checked-in integration, not a claim that a particular
Play-distributed AAB was inspected.

The published [core POM](https://repo.maven.apache.org/maven2/com/stripe/stripeterminal-core/6.0.0/stripeterminal-core-6.0.0.pom)
depends on `stripeterminal-internal-common:6.0.0`. Downloaded official Maven
Central Android archives had these SHA-256 values:

| Artifact | SHA-256 |
| --- | --- |
| [stripeterminal-core-6.0.0.aar](https://repo.maven.apache.org/maven2/com/stripe/stripeterminal-core/6.0.0/stripeterminal-core-6.0.0.aar) | `e0066d9165c93680fa9d0cf2598b93f9e81cc408a4485e9cb72f2c8c594cfc42` |
| [stripeterminal-internal-common-6.0.0.aar](https://repo.maven.apache.org/maven2/com/stripe/stripeterminal-internal-common/6.0.0/stripeterminal-internal-common-6.0.0.aar) | `4a86db10fed7b2cfe9787ae1cf2a200b08562f33e43f7627397bbfb553b0bd27` |

## Collection and precision

1. [Stripe's Android setup instructions](https://docs.stripe.com/terminal/payments/setup-integration?terminal-sdk-platform=android#configure)
   require location to determine where payments occur, reduce fraud and
   minimize disputes; payments are disabled if location cannot be determined.
   That page still instructs integrations to request fine location.
2. The more version-specific [Android 6.0.0 changelog, 5.8.0 Updates](https://github.com/stripe/stripe-terminal-android/blob/6.0.0/CHANGELOG.md#580---2026-08-17)
   says coarse permission is sufficient for location reporting, but **“The SDK
   will still use GPS when `ACCESS_FINE_LOCATION` is granted, falling back to
   the network provider otherwise.”** It also says Bluetooth scan results are
   not used to derive physical location (`neverForLocation`). Do not confuse
   reader discovery with the separate payment-location reporting.
3. Inspection of the released internal-common `classes.jar` using `javap -p -c`
   confirms `LocationHandler.startListening` selects the enabled GPS provider
   when fine permission is granted, otherwise network. `getGeoLocation` copies
   `android.location.Location.getLatitude()` and `getLongitude()` directly into
   `com.stripe.stripeterminal.internal.common.api.Geolocation` as doubles.
4. In the same release, `ApiRequestFactory.ttpaRequestedCardPresent` and
   `legacyRequestedCardPresent` read that geolocation and use
   `String.valueOf(double)` for the `latitude` and `longitude` fields of
   `RequestedPaymentMethod.RequestedCardPresent`, alongside the reader ID.
   `confirmPaymentIntent` passes `createPaymentMethodRequest` into
   `confirmPaymentIntentRequest`. This is an outbound payment-request path,
   not merely OS permission access or a stored business-address `Location` ID.
   No coarsening occurs in this inspected coordinate-to-request path.
   Refund/setup request builders also attach coordinates; this conclusion does
   not depend on enabling offline payments.

**Android answer:** disclose **Precise location collected** for the current
fine-permission integration, and **Approximate location collected** for
network/coarse reporting and IP-derived location. This is a capability exercised
when available, not a promise that every device produces a precise fix.
Google defines precise as an area under 3 square kilometers and explicitly
includes inferred/IP-derived approximate location in its disclosure rules.
The app config currently includes fine permission without an SDK-version cap;
do not change permissions as part of a disclosure-only review.

### Conflicting general documentation

[Stripe's Privacy Center](https://stripe.com/legal/privacy-center#does-stripe-collect-precise-location-data)
says “Stripe does not collect GPS data from devices and browsers,” and describes
approximate/IP-derived location. That general statement does **not** reconcile
the Android-specific changelog and released payment-request code above.
Use the more protective, Android-specific precise disclosure; do not turn the
general statement into an Android “precise not collected” answer. The general
[mobile SDK privacy article](https://support.stripe.com/questions/stripe-mobile-sdk-privacy-details)
is not a version-specific Terminal Android data declaration either.

## Identity linkage and sharing

Android payment coordinates travel in the same request data as a reader ID and
payment method, through an authenticated Stripe payment integration.
`ApiRequestFactory.activateReader` includes the POS device UUID and connection
token in activation data. The app obtains connection tokens for the signed-in
seller (`apps/mobile/components/tap-to-pay-provider.tsx`,
`pages/api/stripe/terminal/connection-token.ts`).
Treat this as **linkable to the seller's device, Stripe account and payment**,
not anonymous/unlinked collection. This does not establish that every fix is
linked to a named cardholder, or how Stripe indexes coordinates internally.

[Stripe's Privacy Policy](https://stripe.com/privacy) defines Transaction Data
as potentially including merchant/location details and describes fraud
prevention using personal data. Its [Privacy Center](https://stripe.com/legal/privacy-center#what-are-stripes-data-controller-activities)
lists fraud/loss prevention and compliance among Stripe's own controller
activities. Accordingly the prepared Play answers disclose sharing with Stripe
for functionality and fraud prevention/security/compliance, rather than assume
every transfer qualifies for Google's service-provider exception. This is a
conservative disclosure decision, not proof of sale or advertising use.
Google Play has no Apple-style per-category “linked to identity” checkbox;
do not copy the iOS manifest's `Linked=false` into Android policy text.

## Retention and control

[Stripe's geolocation retention table](https://stripe.com/legal/privacy-center#how-long-will-stripe-keep-my-data)
covers “Geolocation Data (e.g., IP addresses)” for the duration necessary to
comply with law, provide services, prevent fraud/financial crime, defend legal
rights and comply with valid legal process. [Privacy Policy section 5](https://stripe.com/privacy#5-security-and-retention)
also describes legally required retention beyond account closure.

These sources publish **purpose-based criteria, not an Android Terminal
coordinate-specific duration**. No reviewed source promises immediate deletion,
memory-only processing or a fixed GPS retention period. Answer **not
ephemeral**; do not substitute a general financial-record retention period for
a coordinate TTL. Device permission revocation prevents future permitted
access, not deletion of records already sent to Stripe. Self-sown's application
code does not separately send/store device coordinates on its own backend.

## Reproduction and limits

Download the two linked AARs outside the repository, verify with `sha256sum`,
then extract the internal-common `classes.jar` with `unzip -p`. Run:

```sh
javap -p -c -classpath common.jar \
  com.stripe.stripeterminal.internal.common.LocationHandler
javap -p -c -classpath common.jar \
  com.stripe.stripeterminal.internal.common.api.ApiRequestFactory
javap -p -c -classpath common.jar \
  'com.stripe.proto.api.rest.RequestedPaymentMethod$RequestedCardPresent'
```

This was static inspection of the released Android implementation plus current
vendor/Google documentation, not a traffic capture, a Stripe server audit or a
physical-device test. Server-side retention/identity internals remain private;
the answers above explicitly avoid unsupported anonymity/deletion promises.
On SDK or permission changes repeat the review and inspect the actual release
dependency graph/merged manifest before publishing updated Play answers.
