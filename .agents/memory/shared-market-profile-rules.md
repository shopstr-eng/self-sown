---
name: Shared payment-preference & donation-key rules
description: derivePaymentPreference / isDirectLightningCandidate / donation-key migration live in packages/domain/market-profile.ts, shared by web and mobile; the module must stay dependency-free.
---

Seller payment-preference derivation (fiat/lightning/ecash incl. the zeuspay
hold-invoice carve-out) and the legacy donation-key rule (ss_donation
canonical; mm_donation, shopstr_donation legacy) live in
`packages/domain/src/market-profile.ts`. Web re-exports the derivation from
`utils/lightning/direct-lnurl.ts` so old import sites keep working; mobile
imports `@self-sown/domain` directly (its lib keeps the
`deriveMarketPaymentPreference` name as an alias).

**Why:** web and mobile once each had a copy; a change on one side would
silently make the two apps publish different payment_preference values for the
same seller. Mobile cannot import the web original because it pulls in
@getalby/lightning-tools (too heavy for Expo).

**How to apply:** never re-duplicate these rules — change them in
packages/domain only, and keep that module free of heavy or platform-specific
dependencies (no @getalby/*, no React, no AsyncStorage) or the mobile bundle
breaks. Note the checkout-side donation reads (invoice cards,
utils/stripe/donation.ts) still inline `ss_donation ?? mm_donation` and are a
known remaining drift surface.
