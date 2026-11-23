# App Privacy answers — draft for the version 1.0 submission

App Store Connect blocks version 1.0 on `APP_DATA_USAGES_REQUIRED`. The
questionnaire has no public API, so it must be answered in the web UI at
**App Store Connect → your app → App Privacy → Get Started / Edit → Publish**.

This document is a *draft* of those answers, derived from the shipping mobile
app (`apps/mobile`) and the backend endpoints it calls. **You are the one making
the declaration**, so read it, correct anything that does not match your intent,
and only then publish. Every answer below is grounded in a code path.

Scope: data the app collects, as Apple defines it. The app talks to the platform
backend at `self-sown.com`. Data handled entirely by a payment service provider
(Stripe, Square) is the PSP's collection, not yours — see “Payment info” below.
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

Everything the app collects is tied to the user's account and used only for app
functionality, so it belongs under **Data Linked to You**, not in a tracking or
third-party-advertising bucket. Nothing is in **Data Not Linked to You**.

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
| Location → Precise Location | No (see note) | — | — | — |
| Location → Coarse Location | No | — | — | — |
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
| Usage Data → Product Interaction | No | — | — | — |
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
(`lib/pro-membership.ts`). If you would rather treat PSP-handled card data as
the PSP's collection, you may move this row, but leaving it **collected** is the
safe direction — over-declaring is never a rejection, under-declaring is.

**Credit Info — not collected.** No credit checks and no credit data in the app.

**Other Financial Info — collected.** Lightning address (`lud16`), donation
percent (`ss_donation`), Cashu proofs / mint URLs / balances
(`lib/pos-cashu.ts`), and the Nostr Wallet Connect connection string
(`lib/nwc.ts`) — all payment capabilities tied to the user's own account.

### Location — not collected

The app makes **no** location API calls: `expo-location` is not a dependency and
no code reads device position. The iOS location usage string has been removed.
The only “location” in the code is the Stripe Terminal *account* location id
(`lib/pos-tap-to-pay.ts` `getLocations`), a Stripe-side terminal configuration,
not the device's geolocation. Answer **No** here.

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

### Usage Data, Diagnostics — not collected

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

1. **Unused iOS permission strings — resolved.** Camera and location usage
   strings were removed from `app.config.ts`: the app selects photos through
   the system document picker and does not read device location. These must
   **not** be reported as collection in App Privacy. Android's location
   permission remains for Stripe Terminal's Bluetooth-reader discovery
   requirements; the app does not read or retain device geolocation.
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

## Before you publish

1. **Re-read the “Location”, “Payment Info”, and “Emails or Text Messages”
   rows** — the ones where a reasonable reviewer could argue the other way.
   Over-declaring is the safe direction.
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
