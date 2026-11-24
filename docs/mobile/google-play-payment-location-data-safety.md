# Google Play Data safety: payment location

Prepared **2026-11-24** for the Android integration using Terminal **6.0.0**
through `@stripe/stripe-terminal-react-native` **0.0.1-beta.34**.
[Android release evidence and source links](./stripe-terminal-android-privacy-evidence.md)
support these answers. These are the **payment-location portion**, not a
complete Data safety form for every account, order, messaging or SDK data type.
Do not replace the full app disclosure with this table.

## Answers to enter

| Play data type | Collected | Shared | Ephemeral | Purposes of collection and sharing |
| --- | --- | --- | --- | --- |
| Location → Approximate location | Yes | Yes | No | App functionality; Fraud prevention, security, and compliance |
| Location → Precise location | Yes | Yes | No | App functionality; Fraud prevention, security, and compliance |

- **Approximate location: Required** as the conservative app-wide answer:
  network requests expose IP addresses and Stripe documents deriving location
  from them without a separate location permission. Do not promise that
  denying GPS stops all approximate location collection.
- **Precise location: Optional** for this integration: users can withhold/revoke
  Android location permission and continue using non-Terminal features.
  It is necessary for the current fine-permission Terminal flow, not for every
  use of Self-sown. SDK initialization can occur when a Stripe-enabled seller
  opens the Sell tab; do not claim collection begins only after a successful
  card charge or first reader connection.
- **Identity:** linkable to seller/device/account/payment, not claimed anonymous.
  Play does not ask Apple's “linked to identity” question.
- **Sharing:** disclose transfer to Stripe, including its fraud/compliance
  purposes. Do not automatically claim the service-provider exception for
  all Stripe processing. This does not mean location is sold.
- **Retention:** Stripe's purpose-based geolocation criteria apply; no public
  Android Terminal-specific coordinate deletion deadline was found. No
  ephemeral-processing exception or guaranteed deletion on permission
  revocation/account closure is claimed.
- **Analytics / advertising:** the inspected location path and Terminal setup
  support payment functionality and fraud prevention, not a location-advertising
  purpose. Do not copy the iOS product-interaction declaration into an Android
  location purpose. Other Android SDK analytics categories need their own
  evidence and remain outside this location-only table.

## Google rules used

[Google's Data safety definitions](https://support.google.com/googleplay/android-developer/answer/10787469?hl=en):
include third-party SDK transfers off-device; precise means an area under
3 square kilometers; approximate includes IP-derived location. Ephemeral means
memory-only use no longer than needed for a real-time request. Optional
collection requires every user to have a choice, and disclosures must cover
the union of currently distributed versions/tracks. Before entry, compare this
source integration with active Play artifacts: if any distributed version
requires precise location for the app's primary functionality, select Required
instead. Do not mark location “not collected” just because Self-sown does not
store coordinates itself.

## Publication boundary

The privacy policy source `pages/privacy/index.tsx` now distinguishes Android
from iOS. This document prepares answers only: no Play Console answers, store
listing, app release or website deployment were changed. An authorized release
owner must reconcile the full form with active versions, enter/publish it in
Play Console, and retain its confirmation/export.
