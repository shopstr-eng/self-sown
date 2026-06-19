# Overview

Milk Market is a permissionless Nostr-based marketplace for raw milk and related products. Payments: Bitcoin (Lightning, Cashu), Stripe, manual fiat. Implements 15+ NIPs, with PostgreSQL caching for SSR + analytics. Sellers run customizable storefronts; buyers can check out as guests or with Nostr keys; AI agents participate via the MCP API.

# User Preferences

Preferred communication style: Simple, everyday language.

# Stack

- **Frontend**: Next.js 16 (App Router) + TypeScript v4, React 19, HeroUI, Tailwind, Framer Motion, PWA. State via React Context per domain; localStorage for prefs/auth; service worker caching.
- **Backend**: Next.js API routes, PostgreSQL, Formidable uploads.
- **Runtime**: Node `>=22.4.0` (`.nvmrc` = `22`); `@cashu/cashu-ts` pinned to `4.1.0`.
- **Routing**: Friendly slugs for listings + profiles with pubkey disambiguation; naddr/npub URLs redirect to slugs (`utils/url-slugs.ts`).
- **SSR OpenGraph**: `/listing/`, `/shop/`, `/marketplace/`, `/communities/` fetch from PostgreSQL in `getServerSideProps` and inject meta via `pageProps.ogMeta` → `DynamicHead` (`_app.tsx`).

# External Dependencies

- **Nostr**: Relays for events, Blossom for media, NIP-05 DNS verification.
- **Payments**: Lightning, Cashu Mints, Getalby Lightning Tools (LN address utils), Stripe Connect, SendGrid (transactional email).
- **Email sender domains (Pro/Herd)**: Sellers send flow + order-confirmation/new-order emails from their OWN SendGrid Domain-Authenticated domain. Connect/verify mirrors the storefront custom-domain flow but lives under EMAIL settings (`pages/settings/email-flows.tsx`). Connections in Postgres (`email_sender_domains`), managed via SendGrid Domain Authentication API (`utils/email/sendgrid-domain-auth.ts`). Write endpoints (`pages/api/email/sender-domain.ts`, `verify-sender-domain.ts`) gated by `requireProEntitlement` + `verifyNostrAuth` binding `"email-sender-domain-write"`. **Fail-closed:** the custom from-address is used only when SendGrid reports the domain valid AND the from-email host exactly equals the domain; `sendEmail()` retries once with the global verified sender on a SendGrid 403 verified-sender error, so a misconfigured seller domain never drops an email. Custom-from is used only where the caller is proven to own the seller domain (authed paths resolve from the verified pubkey: order-confirmation/new-order, order/shipping updates, NIP-98-authed flow test sends, flow + one-time emails) OR the recipient is the seller's own server-resolved email (product inquiries, return/refund requests). Subscription lifecycle and the storefront popup welcome stay on the global sender because they're unauthenticated with caller-supplied recipients (custom-from there would enable seller-domain spoofing); platform→user emails (recovery/admin/affiliate/pro receipts/contact form + systemic Stripe payment-failure) also stay global.
- **Shipping**: Shippo via per-seller OAuth ("standalone/gray-label" accounts). Each seller connects their own Shippo account (`Bearer oauth.*` token, never expires, no refresh); Shippo bills the seller directly so the platform holds no shipping float and enforces no spend cap. Registered OAuth callback path `/shippo-oauth-redirect`; needs `SHIPPO_OAUTH_CLIENT_ID` + `SHIPPO_OAUTH_CLIENT_SECRET`. Connections + single-use OAuth state stored in Postgres (`shipping_oauth_connections`, `shipping_oauth_states`). Seller-side label management (connect/start OAuth, signed-seller rates, buy/return labels, defaults POST, parcel-templates POST/DELETE) is a **Herd/Pro feature** gated server-side via `requireProEntitlement`; buyer/guest paths (address verification, buyer rate quotes, OAuth callback/status/disconnect) stay open.
- **Self-host (Wrangler/lifetime)**: A lifetime seller can run their OWN single-tenant copy. Config in `utils/self-host/` (env + optional `milk-market.config.json`, env wins; `getSelfHostConfig`/`isSelfHost`/`isSelfHostTenant`). When `MM_SELF_HOST` is on: marketplace/discovery/Pro-billing AND all platform pages (about/faq/producer-guide/contact/terms/privacy) hidden via `proxy.ts` (pure rules in `utils/self-host/routing.ts`, exact-or-subpath boundary), entitlement bypassed ONLY for the tenant pubkey in `getMembershipView` (fail-closed), and card checkout runs on the seller's OWN standard Stripe account (direct charges, no Connect/fees) in `create-payment-intent.ts` + `connect/seller-status.ts`. Every served page (settings included) is forced into the seller's storefront theme via `_app.tsx` forwarding `x-mm-self-host`→`forceSelfHostChrome` to `StorefrontThemeWrapper` (no Milk Market chrome, no Pro gate), so the seller only ever sees their own branded store; they publish their OWN terms/privacy/return policy via the storefront page builder. Wrangler-gated export endpoint `pages/api/pro/export-store.ts` streams a setup bundle (dependency-free ZIP via `utils/self-host/zip.ts`, contents built by `utils/self-host/export-bundle.ts`) wiring the seller to the public repo for `git pull`. **NEVER packages secrets or other sellers' data** (only the caller's own public config + placeholder templates; `stripSecrets()` defends the branding snapshot). Default hosted behavior UNCHANGED when off. See `docs/architecture/self-host.md`.
- **Libraries**: `crypto-js`, `nostr-tools`, `@cashu/cashu-ts`, `@heroui/react`, `@heroicons/react`, `framer-motion`, `stripe`, `@stripe/stripe-js`, `@stripe/react-stripe-js`, `pdf-lib`, `qrcode`, `@modelcontextprotocol/sdk`.

# Architecture Docs

Deep-dive notes live under `docs/architecture/`. Read the relevant file only when the task touches that area:

- **`auth.md`** — NIP-07/46/49 signers, account recovery flow, PBKDF2/email-verification security.
- **`nostr.md`** — NIPs in use, hybrid event caching (IndexedDB + Postgres + relays), order-message tags (payment method, currency, shipping, grouping, subject routing).
- **`payments.md`** — Lightning + Cashu (`@cashu/cashu-ts` v4 gotchas, hardening utils), Stripe Connect (Express, webhooks, retries, pending-payments, cron cleanup), donation/platform fee, multi-currency cart math, manual fiat, API rate limiting.
- **`inventory.md`** — Centralized Postgres `inventory` + `inventory_log`, variant keys, deduction flows, MCP availability.
- **`features.md`** — Trust/reviews, order summary, email + guest checkout, custom email flows, return/refund requests, bulk/bundle pricing, variants & pickup, Subscribe & Save, cart multi-payment, free shipping threshold, payment method discounts, herdshare, Shopify migration.
- **`storefronts.md`** — Customizable `/shop/[slug]` storefronts (colors, fonts, page builder, SEO/OG meta, built-in shop page), self-serve custom domains (DNS, proxy rewrite, admin).
- **`mcp.md`** — Model Context Protocol server: endpoint, signing, auth (`sk_` keys, 3 perm levels), read/purchase/write tool categories, payment methods, agentic commerce endpoints.
- **`affiliates.md`** — Seller-managed affiliate links + codes (data model, APIs, Stripe + Cashu integration, anti-abuse, cron payouts, email/unsubscribe, operator runbook).
- **`seo.md`** — On-page SEO, GEO citations, dev-mode optimizations (Turbopack, PWA + flow scheduler off in dev).
- **`self-host.md`** — Wrangler (lifetime) single-tenant self-host: config (`utils/self-host/`), tenant-scoped entitlement bypass, proxy marketplace-hiding, own-Stripe direct charges, and the dependency-free export-bundle endpoint.

Other long-form docs:

- **`docs/affiliate-payout-cron.md`** — Scheduled deployment cron details for affiliate payouts.
