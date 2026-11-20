---
name: App Store Tap to Pay entitlement gate
description: The iOS submission path must verify the built app keeps the proximity-reader entitlement before it reaches Apple
---

The Tap to Pay entitlement (`com.apple.developer.proximity-reader.payment.acceptance`) can silently drop out of a built IPA's embedded provisioning profile. Apple's capability is not settable through the ASC API, and a profile created after the capability is enabled can still omit it — the build signs and uploads cleanly and only fails later in App Review.

**Rule:** every iOS path that ships to Apple must verify the built app's embedded profile before submission and abort loudly if the check fails. The enforcement lives in the mobile submission wrapper (see apps/mobile/scripts/README.md); a bare `eas submit` bypasses it.

**Why:** the loss is invisible until App Review, so the gate has to fail before anything Apple-side sees the build.

**How to apply:** route any new iOS submission path (CI, release script, runbook) through the wrapper rather than calling `eas submit` directly.
