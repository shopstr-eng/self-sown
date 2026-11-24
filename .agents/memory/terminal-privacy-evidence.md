---
name: Terminal SDK privacy evidence
description: Use the actual native SDK manifest, not the generic Stripe mobile SDK article or OS permissions, for Terminal disclosures.
---

For iOS, use the resolved native Terminal release's privacy manifest as the SDK-specific
source for collection categories, identity linkage, tracking and purposes.
Stripe's generic mobile SDK article is about other payment SDK flows and is not
a substitute for Terminal-specific evidence. OS permission precision alone does
not establish the precision collected off-device.

**Why:** Terminal's native manifest can explicitly classify collection as coarse
and unlinked even though the app requires location permission. Assuming all
payment-provider data is exempt from App Privacy misses integrated-SDK collection.

**How to apply:** Reinspect the actual release archive and final app privacy
report when upgrading Terminal. For retention, distinguish published
purpose-based geolocation criteria from an unpublished Terminal-specific
duration; never turn general business-record retention into a GPS-reading TTL.

Do not carry iOS coarse/unlinked conclusions over to Android. The Android
release's GPS reporting changelog and actual coordinate-to-payment-request
path can contradict Stripe's general “does not collect GPS” Privacy Center
statement. Disclose based on platform-specific evidence; do not claim anonymity
or ephemeral processing without evidence for that platform.

**Why:** The Android release inspected sends unrounded location with
reader/payment identifiers, unlike the iOS manifest's coarse/unlinked entry.

**How to apply:** Start with the Android evidence and prepared Play location
answers in `docs/mobile/`; repeat release-artifact inspection on native SDK
upgrades. Keep publication of store-console answers separate from source edits.
