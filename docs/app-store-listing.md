# App Store listing — canonical source of truth

This is a human-readable record of the App Store listing for `com.selfsown.mobile`
(app id `6820230704`). The machine-readable source of truth is `LISTING` in
[`apps/mobile/scripts/appstore-listing.mjs`](../apps/mobile/scripts/appstore-listing.mjs);
that file drives the App Store Connect API calls that apply these values. Change
the listing there, run `apply`, and the live listing follows. When the two ever
disagree, the script wins and this doc is stale — update it.

The listing was originally filled with one-off App Store Connect API calls, so a
future version bump or app re-create had to re-derive every value by hand. This
script makes that repeatable.

## Running it

```sh
# report how the live listing differs from the canonical copy (exit 1 on drift)
pnpm --filter @self-sown/mobile appstore:listing:check

# write the canonical values to App Store Connect
pnpm --filter @self-sown/mobile appstore:listing:apply
```

Both accept `--app <id>`, `--version <x>` (defaults to the app's editable iOS
version) and `--locale <l>` (defaults to `en-US`). `apply` only writes fields
that differ, and it creates the app-info or version localization when it is
missing — so it is the command to run after cutting a **new version** (a fresh
version starts with an empty localization).

It authenticates with the same ES256 key as `provision-ios-credentials.mjs` and
`appstore-submission.mjs`: `APP_STORE_CONNECT_KEY_ID`,
`APP_STORE_CONNECT_ISSUER_ID` and `keys/asc-key.p8` (or
`APP_STORE_CONNECT_PRIVATE_KEY`).

## What it sets

| Surface | Value |
| --- | --- |
| App name | Self-sown |
| Subtitle | Local food marketplace & POS |
| Privacy policy URL | https://self-sown.com/privacy |
| Primary category | Food & Drink (`FOOD_AND_DRINK`) |
| Content rights | Uses third-party content (`USES_THIRD_PARTY_CONTENT`) |
| Support URL | https://self-sown.com/contact |
| Marketing URL | https://self-sown.com |
| Copyright | 2026 Self-sown |
| Keywords | `farm,food,marketplace,farmer,produce,meat,eggs,honey,pos,tap to pay,local,sell` |
| Price | Free (base territory US) |
| Age rating | 4+ (messaging, social media and user-generated content only) |

### Description

> Self-sown is a marketplace and point-of-sale app for local food producers and artisan makers. Sell farm-fresh food - produce, meat, eggs, dairy, baked goods, honey, and preserves - directly to buyers, and take in-person card payments with Tap to Pay on iPhone.
>
> SELL
> - Create rich product listings with photos, pricing, and shipping options.
> - Take payments your way: Tap to Pay on iPhone for contactless cards and wallets, Lightning, Cashu ecash, cards (Stripe or Square), or cash.
> - Manage orders, inventory, and fulfillment in one place.
> - Run a custom storefront on your own domain, publish blog posts, and send email campaigns.
> - Get paid directly - payouts settle to your connected Stripe or Square account.
>
> SHOP
> - Browse a live marketplace of local producers.
> - Buy with Bitcoin (Lightning, Cashu), card, or cash, with guest checkout supported.
> - Track orders and message sellers directly, end to end encrypted.
>
> WHO IT'S FOR
> Farmers, ranchers, homesteaders, market vendors, bakers, beekeepers, and local artisan producers who want to sell directly - without platform gatekeeping.
>
> Built on the open Nostr protocol: you own your identity and your customers, and your store works with the tools and agents you choose.
>
> Self-sown is free to start. A Pro membership adds a custom domain, email flows, and agent access.

## Reuse on a release

Before submitting a new version (see `docs/apple-review/README.md` for the
submission handoff):

```sh
pnpm --filter @self-sown/mobile appstore:listing:apply   # fill the new version's localization
pnpm --filter @self-sown/mobile appstore:listing:check   # confirm no drift
```

## Not settable through this script

- **App Privacy / data usages** — App Store Connect exposes no public API
  (`appDataUsages`); publish in the web UI. See `docs/apple-review/README.md`.
- **Screenshots** and the **App Review walkthrough attachment** — see
  `appstore-submission.mjs`.
- **Changing an existing price** — Apple's API allows `CREATE` and `GET` on
  `appPriceSchedules` only, so a schedule that is not free everywhere must be
  corrected in App Store Connect. `apply` will set the free schedule for a new
  app but fails loudly (rather than silently) if an existing schedule is paid.
