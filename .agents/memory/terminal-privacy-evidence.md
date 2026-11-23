---
name: Terminal SDK privacy evidence
description: Use the actual native SDK manifest, not the generic Stripe mobile SDK article or OS permissions, for Terminal disclosures.
---

Use the resolved native Terminal release's privacy manifest as the SDK-specific
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
