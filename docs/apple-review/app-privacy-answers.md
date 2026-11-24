# App Privacy answers — draft for the version 1.0 submission

App Store Connect blocks version 1.0 on `APP_DATA_USAGES_REQUIRED`. The
questionnaire has no public API, so it must be answered in the web UI at
**App Store Connect → your app → App Privacy → Get Started / Edit → Publish**.

This document is a *draft* of those answers, derived from the shipping mobile
app (`apps/mobile`) and the backend endpoints it calls. **You are the one making
the declaration**, so read it, correct anything that does not match your intent,
and only then publish. Answers are grounded in app code and vendor disclosures.
The Terminal location review below was verified on **2026-11-23**. These are
prepared answers, not confirmation that the live App Store label was updated.

Scope: data the app collects, as Apple defines it. The app talks to the platform
backend at `self-sown.com`. Include collection by integrated third-party SDKs,
even when Self-sown's backend never receives that data. Apple's exception for
payment information entered outside the app is not a blanket PSP exemption.
Buyer-facing *web* storefront flows (contact form, popup opt-in) share that
backend but are not reachable from the iOS app, so they are out of scope and
called out where relevant.

---

## Summary

**Data used to track you: NONE.** The app bundles no advertising SDK, no
analytics SDK, and no attribution or identity-linking framework, and does not
access the advertising identifier (`ASIdentifierManager` / IDFA / IDFV). The
`NSUserTrackingUsageDescription` key is not present and no ATT prompt is shown.
Answer every “used for tracking” question **No**.

Account-related collection belongs under **Data Linked to You**. Stripe
Terminal's coarse location and product-interaction collection belongs under
**Data Not Linked to You**, according to its native privacy manifest. Product
interaction is used for Analytics as well as App Functionality; neither
Terminal category is used for tracking.

| Apple category | Collected | Linked to identity | Tracking | Purpose |
| --- | --- | --- | --- | --- |
| Contact Info → Name | Yes | Yes | No | App Functionality |
| Contact Info → Email Address | Yes | Yes | No | App Functionality |
| Contact Info → Phone Number | Yes | Yes | No | App Functionality |
| Contact Info → Physical Address | Yes | Yes | No | App Functionality |
| Contact Info → Other User Contact Info | Yes | Yes | No | App Functionality |
| Health & Fitness | No | — | — | — |
| Financial Info → Payment Info | Yes | Yes | No | App Functionality |
| Financial Info → Credit Info | No | — | — | — |
| Financial Info → Other Financial Info | Yes | Yes | No | App Functionality |
| Location → Precise Location | No | — | — | — |
| Location → Coarse Location | Yes | No | No | App Functionality |
| Sensitive Info | No | — | — | — |
| Contacts | No | — | — | — |
| User Content → Photos or Videos | Yes | Yes | No | App Functionality |
| User Content → Emails or Text Messages | Yes (see note) | Yes | No | App Functionality |
| User Content → Audio / Gameplay | No | — | — | — |
| User Content → Other User Content | Yes | Yes | No | App Functionality |
| Browsing History | No | — | — | — |
| Search History | No | — | — | — |
| Identifiers → User ID | Yes | Yes | No | App Functionality |
| Identifiers → Device ID | Yes | Yes | No | App Functionality |
| Purchases → Purchase History | Yes | Yes | No | App Functionality |
| Usage Data → Product Interaction | Yes | No | No | App Functionality; Analytics |
| Usage Data → Advertising Data | No | — | — | — |
| Usage Data → Other Usage Data | No | — | — | — |
| Diagnostics → Crash / Performance / Other | No | — | — | — |
| Other Data | No | — | — | — |

---

## Per-category reasoning

### Contact Info

**Name — collected.** Seller display name is part of the public profile; the
recipient name on a saved shipping address and the label origin name are also
names. Evidence: `lib/market-profile.ts` (`displayName`, `username`),
`lib/saved-addresses.ts` (`name`), `app/(tabs)/shipping.tsx` (`fromName`).

**Email Address — collected.** Three uses: (a) the seller's login email
(`app/email-auth.tsx` → `mobileApiClient.emailSignIn` / `emailSignUp`); (b) an
optional account-recovery email stored server-side and shown back masked
(`lib/account-recovery.ts` → `setup-recovery`); (c) a buyer email captured at
checkout / POS for receipts and seller contact (`lib/pos-sale.ts`,
`lib/order-presenter.ts`; order `buyer_email` tag in `packages/domain/src/
order.ts`). The label-origin email (`fromEmail`) is also collected.

**Phone Number — collected.** The seller's shipping label origin can include a
phone number. Evidence: `app/(tabs)/shipping.tsx` (`fromPhone`, a
`SellerShippingDefaults` field saved to the backend).

**Physical Address — collected.** Saved shipping addresses (name, street, unit,
city, state, ZIP, country) plus the label-origin address, and the buyer shipping
address attached to an order. Evidence: `lib/saved-addresses.ts`,
`app/(tabs)/shipping.tsx` (`fromStreet1`…`fromCountry`),
`packages/domain/src/order.ts` (`address` tag).

**Other User Contact Info — collected.** Public profile handles that are not
name/email/phone: NIP-05 identifier, username, avatar URL, the fiat payment
handles (Venmo / Zelle / Cash App / Apple Pay / Google Pay / PayPal), and the
Lightning address a seller publishes to get paid. Evidence:
`lib/market-profile.ts` (`nip05`, `lud16`, `picture`, `FIAT_OPTION_FIELDS`).

### Financial Info

**Payment Info — collected.** Card numbers never reach the app (they are
captured by the Stripe Terminal / Square SDKs and the PSP's hosted flows), but
the app transmits and stores payment *identifiers and references*, which Apple
counts as Payment Info: the Stripe PaymentIntent id, Square payment id, or
invoice hash on every POS sale (`lib/pos-sale.ts` `paymentReference`), the
Stripe/Square connected-account records (`lib/stripe-connect.ts`,
`lib/square-connect.ts`), and membership subscription references
(`lib/pro-membership.ts`). Assess PSP-handled card data separately using Apple's
payment-information exception; declarations must reflect the evidence rather
than assuming over-declaring is always safe.

**Credit Info — not collected.** No credit checks and no credit data in the app.

**Other Financial Info — collected.** Lightning address (`lud16`), donation
percent (`ss_donation`), Cashu proofs / mint URLs / balances
(`lib/pos-cashu.ts`), and the Nostr Wallet Connect connection string
(`lib/nwc.ts`) — all payment capabilities tied to the user's own account.

### Location — coarse collected; precise not collected

**Coarse Location — collected, not linked to identity, not used for tracking,
App Functionality. Precise Location — not collected.** These answers come from
Stripe Terminal iOS **6.0.0**'s device and simulator privacy manifests, not
from inferring collection from a permission. The installed React Native
wrapper **0.0.1-beta.34** requests iOS SDK `6.0.x`.

The manifest explicitly declares `NSPrivacyCollectedDataTypeCoarseLocation`
with linked and tracking both `false`, for App Functionality, and does not
declare precise location. Stripe's Privacy Center also states it does not
collect GPS data. Self-sown has no separate device-coordinate collection path.
The Terminal account location ID (`getLocations`) is a business-address record,
not a reading of device position.

Stripe requires location access to accept in-person payments, reduce fraud and
minimize disputes. This third-party collection counts under Apple's definition
even though Self-sown does not store device coordinates. Stripe publishes
purpose-based retention criteria for geolocation data: providing services,
complying with law, preventing fraud/financial crime, and legal claims/process.
It does **not** publish a Terminal-specific location retention duration or
promise immediate deletion after a request. Do not invent either a duration
or a real-time-only exemption. Do not declare precise location simply because
the OS permission can grant it.

See [Terminal privacy evidence](./stripe-terminal-privacy-evidence.md) for
the verified archive checksum, manifest contents, sources, and retention limits.

### Sensitive Info / Contacts — not collected. No sensitive-category data, no
address-book access, no contacts permission.

### User Content

**Photos or Videos — collected.** Sellers choose product, blog, community, and
profile images from the device (an `image/*` document picker) and upload them to
their own content. Evidence: `lib/listing-images.ts`
(`DocumentPicker.getDocumentAsync({ type: "image/*" })`),
`lib/listing-upload-results.ts`.

**Emails or Text Messages — collected (order conversations).** Order chats are
stored as kind-14 gift-wrapped messages, end-to-end encrypted, and read back by
the seller. Evidence: `packages/domain/src/order.ts`, `lib/order-query.ts`,
`lib/order-notification-outbox.ts`. (The app does not read the device's email
inbox or SMS; if you scope this category to “the user's own inbox” you may move
it to Other User Content, but keeping it declared is the safe direction.)

**Other User Content — collected.** Listings (titles, descriptions, prices,
quantities), blog posts, storefront content, community posts, and the optional
AI-assistant conversation (posted to `/api/assistant/chat` and processed by
Anthropic). Evidence: `lib/listing-editor-state.ts`, `lib/blog.ts`,
`lib/communities.ts`, `lib/assistant.ts`.

### Browsing History — not collected. Native app; no cross-site browsing data.

### Search History — not collected. No in-app search that records queries.

### Identifiers

**User ID — collected.** Every account is a Nostr keypair; the public key (npub)
is the account identifier, sent to every authed endpoint and published with the
user's own content. Evidence: `stores/session-store.ts`, `lib/nip98.ts`,
`@self-sown/nostr` (`encodeSellerNpub`).

**Device ID — collected.** If a seller turns on order alerts, the app registers
the device push token together with a random installation ID, the platform, and
that seller's account; the backend stores the token encrypted. It is revoked
when alerts are turned off. Evidence: `lib/notification-runtime.ts`
(`getExpoPushTokenAsync`), `lib/notification-registration.ts` (`installationId`,
`deviceId`), `utils/notifications/device-registration.ts`. No IDFA/IDFV is read.

### Purchases

**Purchase History — collected.** Order records (items, amounts, status,
fulfillment), in-person POS sales, and membership/subscription state. Evidence:
`lib/order-query.ts`, `lib/order-actions.ts`, `lib/pos-sale.ts`,
`lib/pro-membership.ts`.

### Usage Data — Terminal product interaction collected

**Product Interaction — collected, not linked to identity, not used for
tracking, App Functionality and Analytics.** Terminal iOS 6.0.0's native
manifest declares these exact values alongside coarse location. Include this
even though no standalone analytics SDK is installed. See the same
[Terminal privacy evidence](./stripe-terminal-privacy-evidence.md).

### Other Usage Data, Diagnostics — not collected by the reviewed app paths

No analytics or crash/performance-reporting SDK is bundled (no Sentry,
Crashlytics, Firebase Analytics, Amplitude, Mixpanel, Segment, PostHog), the app
has no in-app search that records queries, and there is no in-app browser
history. Network requests to the platform API are ordinary service traffic, not
Apple's “Usage Data”. Verified by dependency audit of
`apps/mobile/package.json`. (The backend has server-side *website* analytics for
the web app — IP, user-agent, referrer, UTM — but that is not the iOS app's
collection.)

### Other Data — not collected.

---

## Flags this audit raised

1. **Location SDK review — resolved.** Keep the iOS location purpose string:
   Stripe Terminal requires it for payments. Declare coarse location only,
   not linked, not tracking, App Functionality. Do not confuse device access
   with the precision of data collected off-device. Camera remains unused;
   the system document picker selects photos.
2. **Collected but not clearly disclosed in the listing copy.** The store
   description mentions photos, payments, orders, and messaging, but does not
   surface that the app collects the seller's shipping **origin phone/email and
   address**, the **buyer's email and shipping address**, and a **device push
   token**. These are all App Functionality and belong in the answers; the
   listing copy should at least not contradict them.
3. **Buyer web flows are out of scope.** The web storefront contact form
   (`pages/api/storefront/contact-form.ts`) and popup opt-in
   (`pages/api/storefront/popup-capture.ts`) collect visitor name/email/phone,
   but are not reachable from the iOS app. Flagged only so nobody adds them by
   mistake, and so a future buyer-facing expansion revisits this doc.

---

## Native permissions and privacy-relevant dependencies

This inventory is checked against `apps/mobile/app.config.ts` and
`apps/mobile/package.json` by
`__tests__/mobile/app-privacy-parity.test.ts`. Keep the exact platform key or
dependency name here when changing the app configuration.

### iOS usage descriptions

- `NSPhotoLibraryUsageDescription` — “Self-sown needs access to your photo library so you can attach product photos to your listings.” **COLLECTED:** selected photos, under User Content → Photos or Videos.
- `NSLocationWhenInUseUsageDescription` — “Self-sown uses your location while you accept in-person payments to verify where the payment takes place and help reduce fraud.” **COLLECTED:** Stripe Terminal declares coarse location only, not linked, not tracking, App Functionality.
- `NSBluetoothAlwaysUsageDescription` — “Self-sown uses Bluetooth to connect to nearby card readers for in-person payments.” **NOT COLLECTED:** Bluetooth is used to connect a payment reader; payment references are covered under Financial Info → Payment Info.
- `NSBluetoothPeripheralUsageDescription` — “Self-sown uses Bluetooth to connect to nearby card readers for in-person payments.” **NOT COLLECTED:** Bluetooth is used to connect a payment reader; payment references are covered under Financial Info → Payment Info.

### Android permissions

- `android.permission.NFC` — **NOT COLLECTED:** NFC supports Tap to Pay; it does not collect a separate data category.
- `android.permission.BLUETOOTH_CONNECT` — **NOT COLLECTED:** connects to card readers; it does not collect a separate data category.
- `android.permission.BLUETOOTH_SCAN` — **NOT COLLECTED:** discovers card readers; it does not collect device location.
- `android.permission.ACCESS_FINE_LOCATION` — **COLLECTED:** Android Terminal 6.0.0 can use GPS and sends unrounded coordinates in payment requests with reader/payment identifiers. Disclose precise and approximate location for Google Play; do not apply the iOS coarse/unlinked answer. See [Android release evidence](../mobile/stripe-terminal-android-privacy-evidence.md) and [prepared Play location answers](../mobile/google-play-payment-location-data-safety.md). Stripe publishes purpose-based retention criteria, not an Android Terminal coordinate-specific deletion deadline.

### Privacy-relevant app dependencies

- `@react-native-async-storage/async-storage` — **NOT COLLECTED:** local app storage; data sent to the service is declared under the relevant categories above.
- `@stripe/stripe-terminal-react-native` — **COLLECTED:** payment references under Financial Info → Payment Info; the native iOS SDK also declares coarse location (App Functionality) and product interaction (App Functionality; Analytics), both not linked and not tracking. Raw card details are handled by the payment provider, not stored by the app.
- `expo-device` — **COLLECTED:** device/installation identifiers used with push registration, under Identifiers → Device ID.
- `expo-document-picker` — **COLLECTED:** seller-selected photos, under User Content → Photos or Videos.
- `expo-notifications` — **COLLECTED:** opted-in push token and installation identifiers, under Identifiers → Device ID.
- `expo-secure-store` — **NOT COLLECTED:** stores credentials locally on the device; it does not send them to the service.

---

## Before you publish

1. **Enter the verified Terminal answers:** under Data Not Linked to You,
   select Coarse Location → App Functionality and Product Interaction →
   App Functionality + Analytics; answer tracking No for both. Do not select
   Precise Location based on the permission alone. Re-read “Payment Info” and
   “Emails or Text Messages” separately; location is settled by vendor evidence,
   not a preference for over-declaring.
2. **Check the disclosure matches the listing** (see flag 2 above).
3. Publish, then confirm the blocker cleared:

```sh
pnpm --filter @self-sown/mobile appstore:status
# STATE_ERROR.APP_DATA_USAGES_REQUIRED should be gone
```

## Keeping this current

Re-run this audit when the app adds a third-party SDK (especially anything
analytics, crash, or ad related), adds location or camera access, or starts
collecting a new field. A new permission string or SDK is the single most common
way an App Privacy declaration silently becomes wrong.
