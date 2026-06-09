---
name: Onboarding flow redirects
description: Inserting a step into the seller onboarding wizard requires updating multiple redirect entry points, not just the linear "Next" chain.
---

The seller onboarding wizard is `new-account → user-type → choose-plan → market-profile → shop-profile → stripe-connect`, with `type`, `plan`, and `migrate` threaded as query params via per-page `URLSearchParams` builders.

**Rule:** When you insert or move a step, you must update _every_ redirect that targets the wizard, not just the visible "Next" button chain. There are at least two non-obvious auto-redirects for the Shopify migration funnel:

- `pages/onboarding/new-account.tsx` — after account creation, `migrate === "shopify"` redirects sellers past role selection.
- `pages/onboarding/user-type.tsx` — a `useEffect` also auto-redirects `migrate === "shopify"` sellers (in case they land on user-type directly).

**Why:** Missing one silently bypasses the new step (e.g. Shopify migrants skipping plan choice) and drops threaded params like `plan`. The buyer path intentionally skips `choose-plan` (buyers go straight to `market-profile`).

**How to apply:** grep the whole `pages/onboarding/` dir for `router.push`/`router.replace` and `migrate === "shopify"` before assuming the flow is linear. Step-number labels are hardcoded per page (seller profile=Step 4, stall=5, card=6; buyer profile stays Step 3) — keep them in sync when reordering.

**Custom-stall sign-ups bypass role selection (buyer-only):** A sign-up started on a seller's custom stall/domain must always become a buyer and skip `user-type`. There are MANY sign-up entry points in `SignInModal`, and they don't all route the same way: the 5 in-modal completions (nostr extension/bunker/nsec/ncryptsec, email sign-up, recovery-key close) can route directly to `/onboarding/market-profile?type=buyer`, but **"Create New Account"** (→`new-account`→`user-type`) and **OAuth/Google sign-up** (→external→`oauth-success`→`user-type` for new users) leave the modal first and only rejoin at `user-type`. The custom-stall signal in the modal is `!!sellerBranding`. Cover the leave-the-modal paths with a timestamped `localStorage` marker (`buyerOnlySignup`) set only on a custom stall, consumed+cleared once in `user-type` with a short TTL (stale markers from abandoned/cancelled OAuth must be ignored), plus clear-on-open when the modal mounts off a custom stall. **Why:** `localStorage` is origin-scoped and survives the OAuth full-page round-trip, but stall-slug routes share the `milk.market` origin with the main marketplace, so an un-TTL'd marker could force a later unrelated seller sign-up into the buyer flow. **Rule:** every surface that mounts `SignInModal` on a stall route must render it under `StorefrontBrandingProvider` (or pass `sellerBranding` explicitly) so it stays branded + buyer-gated. Mounting the modal as a sibling _outside_ `StorefrontThemeWrapper` silently drops branding, because the provider only wraps the wrapper's `children` and only when the seller has a Pro custom storefront (`hasCustomStorefront`). Non-Pro stalls render fully unthemed, so an unbranded (Milk Market) modal correctly matches them — branding is intentionally tied to Pro storefront presence, the same signal the other branded surfaces (`protected-route`, `profile-dropdown`) use.
