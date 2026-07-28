---
name: Stripe Connect regional support (country, tax, Square FX)
description: Stripe account country is immutable and fail-closed across ALL create-account clients; tax registrations are region-shaped per country; Square crypto charges convert to the location currency.
---

Stripe Connect Express **country is immutable after creation** and omitting it silently defaults to the platform's country (US). create-account therefore fails closed: missing country → 400 `country_required`, unsupported → 400 `unsupported_country` (validated against `utils/stripe/connect-countries.ts`). There is NO legacy default.

**Why:** A non-US seller who got a US account was irreversibly stuck in US-only onboarding (SSN, US bank). Code review caught mobile + MCP clients silently inheriting the US default.

**How to apply:** Any NEW create-account client must send an explicit `country`. Current senders: payments settings modal, onboarding/stripe-connect.tsx, mobile dashboard (apps/mobile), MCP `create_stripe_connect_account` (required zod param), via `country` on `StripeAuthPayload` in packages/api-client. Mobile has no picker lib — the country list is duplicated in `packages/api-client` (`STRIPE_CONNECT_COUNTRIES`); keep both copies in sync.

Stripe Tax registrations are region-shaped per country: US → `country_options.us { state, type: state_sales_tax }`; CA → `ca { type: province_standard, province_standard { province } }`; everywhere else → `{ [cc]: { type: "standard" } }` (whole-country VAT). Legacy `state`-only bodies still imply US. RegistrationSummary.state holds the subdivision code (US state or CA province), null for whole-country.

Square crypto-denominated charges convert sats → the seller's **location currency** via `satsToFiat(sats, currency)` (per-currency last-good cache, same fail-closed retry semantics as `satsToUSD`, which remains a thin wrapper). Only fiat-cart/location mismatches still 400 `currency_mismatch`.
