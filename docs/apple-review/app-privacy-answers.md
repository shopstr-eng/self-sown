# App Privacy answers — draft for the version 1.0 submission

App Store Connect blocks version 1.0 on `APP_DATA_USAGES_REQUIRED`. The
questionnaire has no public API, so it must be answered in the web UI at
**App Store Connect → your app → App Privacy → Get Started / Edit → Publish**.

This document is a *draft* of those answers, derived from the shipping mobile
app (`apps/mobile`). **You are the one making the declaration**, so read it,
correct anything that does not match your intent, and only then publish.

Scope: data the app collects, as Apple defines it. Data handled entirely by a
payment service provider (Stripe, Square) is the PSP's collection, not yours —
see “Payment info” below for the reasoning.

---

## Summary

**Data used to track you: NONE.** The app bundles no advertising SDK, no
analytics SDK, and no attribution or identity-linking framework, and does not
access the advertising identifier. The `NSUserTrackingUsageDescription` key is
not present and no ATT prompt is shown. Answer every “used for tracking”
question **No**.

Everything the app collects is tied to the user's account and used only for app
functionality, so it belongs under **Data Linked to You**, not in a tracking or
third-party-advertising bucket.

| Apple category | Collected | Linked to identity | Tracking | Purpose |
| --- | --- | --- | --- | --- |
| Contact Info → Name | Yes | Yes | No | App Functionality |
| Contact Info → Email Address | Yes | Yes | No | App Functionality |
| Contact Info → Phone Number | No | — | — | — |
| Contact Info → Physical Address | Yes | Yes | No | App Functionality |
| Contact Info → Other User Contact Info | Yes | Yes | No | App Functionality |
| Financial Info → Payment Info | No | — | — | — |
| Location → Precise / Coarse | No (see note) | — | — | — |
| Sensitive Info | No | — | — | — |
| Contacts | No | — | — | — |
| User Content → Photos or Videos | Yes | Yes | No | App Functionality |
| User Content → Emails or Text Messages | Yes | Yes | No | App Functionality |
| User Content → Other User Content | Yes | Yes | No | App Functionality |
| Browsing History | No | — | — | — |
| Search History | No | — | — | — |
| Identifiers → User ID | Yes | Yes | No | App Functionality |
| Identifiers → Device ID | Yes | Yes | No | App Functionality |
| Purchases → Purchase History | Yes | Yes | No | App Functionality |
| Usage Data → Product Interaction | No | — | — | — |
| Diagnostics → Crash / Performance | No | — | — | — |
| Other Data | No | — | — | — |

---

## Per-category reasoning

### Name — collected

Seller display name is part of the public profile; buyer names appear on saved
shipping addresses. Stored on the platform to render listings, profiles and
order records.
Evidence: `lib/market-profile.ts` (`displayName`, `username`),
`lib/saved-addresses.ts` (`name`).

### Email Address — collected

Two distinct uses: (a) a **buyer email** captured at checkout so the seller can
contact the buyer and send receipts; (b) an optional **account-recovery email**
stored server-side and only ever shown back masked.
Evidence: `lib/order-presenter.ts` (`buyerEmail`), `lib/account-recovery.ts`
(`maskRecoveryEmail`).

### Phone Number — not collected

The app has no phone-number field and requests no phone permission. Stripe's
hosted Connect onboarding may ask a merchant for a phone number, but that is
Stripe's collection, not the app's.

### Physical Address — collected

Buyers can save shipping addresses (name, street, city, state, ZIP, country) and
send one to the seller with an order. Saved addresses persist on the device,
keyed per account.
Evidence: `lib/saved-addresses.ts`, `lib/order-actions.ts` (`productAddress`).

### Other User Contact Info — collected

Public profile handles that are not name/email/phone: NIP-05 identifier,
username, avatar URL, and the Lightning address (`lud16`) a seller publishes to
get paid. These are published to the seller's own profile event.
Evidence: `lib/market-profile.ts` (`nip05`, `lud16`, `picture`).

### Payment Info — not collected by the app

Card data is captured by the Stripe Terminal / Square SDKs and the PSP's hosted
flows; the app never receives or stores a card number, and the Tap to Pay flow
runs inside Apple's and Stripe's UI. In-app wallet balances and Lightning
invoices are amounts tied to the user's own account, not payment credentials.
If you would rather be conservative here, switching this row to “collected —
App Functionality, linked” is the safe direction; it is never a rejection to
over-declare here, only to under-declare.

### Location — not collected

The app makes **no** location API calls: `expo-location` is not a dependency and
no code reads position. `NSLocationWhenInUseUsageDescription` is declared so the
Stripe Terminal SDK can connect to Bluetooth card readers, which is a device
capability the app does not read from or store. **Confirm this row with Apple if
you want certainty**, since the declared usage string invites the question.

### Photos or Videos — collected

Sellers choose product and blog images from the device (an `image/*` document
picker) and upload them to their own listing/blog.
Evidence: `lib/listing-images.ts` (`DocumentPicker.getDocumentAsync({ type:
"image/*" })`), `lib/listing-upload-results.ts`.

### Emails or Text Messages — collected

Order conversations between buyer and seller are stored as messages so both
sides can read them later.
Evidence: `lib/order-presenter.ts`, `lib/order-notification-outbox.ts`.

### Other User Content — collected

Listings (titles, descriptions, prices, quantities), blog posts, and reviews the
user authors.
Evidence: `lib/listing-editor-state.ts`, `lib/blog.ts`.

### User ID — collected

Every account is a Nostr keypair; the public key (npub) is the account
identifier and is published with the user's own content.
Evidence: `lib/session-lifecycle.ts`, `lib/market-profile.ts`.

### Device ID — collected

If a seller turns on order alerts, the app registers the device's push token
together with an installation ID and the platform, bound to that seller's
account server-side, so the platform can deliver notifications. It is revoked
when alerts are turned off.
Evidence: `lib/notification-runtime.ts` (`getExpoPushTokenAsync`, `platform`),
`lib/notification-registration.ts` (`deviceId`).

### Purchase History — collected

Order records (items, amounts, status, fulfillment) are kept for both buyer and
seller.
Evidence: `lib/order-query.ts`, `lib/order-actions.ts`.

### Usage Data, Diagnostics, Search / Browsing History — not collected

No analytics or crash-reporting SDK is bundled, the app has no in-app search
that records queries, and there is no in-app browser history. Network requests
to the platform API are ordinary service traffic, not Apple's “Usage Data”.
Verified by dependency audit of `apps/mobile/package.json` (no Sentry,
Crashlytics, Firebase Analytics, Amplitude, Mixpanel, Segment, PostHog).

---

## Before you publish

1. **Re-read the “Location” and “Payment Info” rows.** They are the two where a
   reasonable reviewer could argue the other way, and they are the ones most
   worth a second opinion.
2. **Check the disclosure matches the listing.** The description promises Tap to
   Pay, order management and email campaigns — all covered above — and nothing
   in it implies tracking.
3. Publish, then confirm the blocker cleared:

```sh
pnpm --filter @self-sown/mobile appstore:status
# STATE_ERROR.APP_DATA_USAGES_REQUIRED should be gone
```

## Keeping this current

Re-run this audit when the app adds a third-party SDK (especially anything
analytics, crash or ad related), adds location access, or starts collecting a
new field such as a phone number. A new SDK is the single most common way an App
Privacy declaration silently becomes wrong.
