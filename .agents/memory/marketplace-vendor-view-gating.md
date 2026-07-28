---
name: Marketplace single-vendor view gating
description: The /marketplace/[slug] single-vendor layout must be gated on focusedPubkey, never on optional cosmetic shop fields (banner); SSR must render no-shop-profile vendors who have listings.
---

The single-vendor marketplace view (vendor nav bar + SideShopNav sidebar in `components/home/marketplace.tsx`) must gate on `focusedPubkey` alone, never on `shopBannerURL` or any other optional cosmetic field. The banner was originally used as a proxy for "has set up a stall", which made vendors without branding silently fall back to the generic marketplace look (products filtered, but no vendor page).

**Why:** "Visit vendor" routes every seller to `/marketplace/[slug]`; a vendor page's identity is the pubkey, not whether they uploaded a banner. Cosmetic-field proxies for feature-setup always leak this class of bug.

**How to apply:**

- Gate vendor-page UI on `focusedPubkey` (plus fetch-state), and use the `sellerName` fallback chain (shop name → ssrSellerName → "Seller Stall") for identity.
- SSR (`pages/marketplace/[[...npub]].tsx`) must render a vendor page when the pubkey has listings even with no kind:30019 shop event; only `notFound` when there is no shop profile AND no products — otherwise arbitrary npub URLs become infinite crawlable stubs.
- Seed client `focusedPubkey` from the SSR-resolved `initialFocusedPubkey` (SellerView effect). The client-side slug→pubkey resolution depends on the relay-loaded profile map, which vendors without a kind:0 profile never satisfy — an empty focusedPubkey silently renders the FULL unfiltered marketplace (other sellers' products) on the vendor route.
