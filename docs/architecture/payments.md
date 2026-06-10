# Payment Systems

## Lightning & Cashu

- **Lightning**: Direct invoice gen + verify.
- **Cashu**: `@cashu/cashu-ts` v4.1.0 (`Mint`/`Wallet`/`Keyset`, bolt11-suffixed quote helpers, `Amount` boundary type with `.toNumber()`, `KeyChain.getKeysets()`, explicit `await wallet.loadMint()`, `getDecodedToken(token, keysetIds)` requires the second arg).
- **Proof amount JSON gotcha**: Proofs in `localStorage["tokens"]` lose the `Amount` wrapper on JSON round-trip and come back as plain `number`. Code reading `getLocalStorageData().tokens` must use `proofAmountToNumber` / `sumProofAmounts` from `utils/cashu/proof-amount.ts`, not `.amount.toNumber()`.
- **Hardening utilities** (`utils/cashu/`): `mint-retry-service` (`withMintRetry`), `swap-retry-service` (`safeSwap`), `melt-retry-service` (`safeMeltProofs`), `pending-mint-operations` (DB-backed `pending_mint_quotes` for orphan recovery), `wallet-recovery` (boot reconciler via `components/utility-components/mint-recovery-boot.tsx`). All cashu call sites use these wrappers and check melt/swap status before treating ops as successful.

## Stripe Connect

- **Express Connect** with embedded Stripe Elements (PaymentIntent API). Card form: `components/utility-components/stripe-card-form.tsx`. PaymentIntent: `pages/api/stripe/create-payment-intent.ts`.
- **Currency utils** (`utils/stripe/currency.ts`): `satsToUSD`, `isCrypto`, `toSmallestUnit`, `convertToSmallestUnit`, `ZERO_DECIMAL_CURRENCIES`. Live BTC→fiat via `@getalby/lightning-tools` (no hardcoded fallback). Stripe payments use the native fiat currency directly; only sats/BTC convert to USD.
- **Webhooks** (`webhook.ts`, `subscription-webhook.ts`): require `STRIPE_WEBHOOK_SECRET` / `STRIPE_SUBSCRIPTION_WEBHOOK_SECRET`, reject unverified payloads, dedupe via `claimStripeEvent` (`stripe_processed_events`, fail-open). Both honor `application_fee.created`/`refunded` for donation reconciliation.
- **Retries & idempotency**: `withStripeRetry` (`utils/stripe/retry-service.ts`) wraps API calls. All PaymentIntent / Subscription / Invoice / Transfer create calls use a deterministic `stableIdempotencyKey()`.
- **Pending payments & failures**: `stripe_pending_payments` (`utils/stripe/pending-payments.ts`); webhook updates status. Failures email both parties (`sendPaymentFailedToBuyer`/`Seller`); transfer failures alert admin (`sendTransferFailureAlert`).
- **Cron cleanup** (`pages/api/stripe/cron-cleanup.ts`, gated by `FLOW_PROCESSOR_SECRET`): prunes `stripe_processed_events` >45d and terminal `stripe_pending_payments` (`succeeded`/`failed_terminal`/`abandoned`) >30d. Active rows preserved.

### Sales tax (Stripe Tax)

US sales tax for Express sellers — **on by default** (sellers can turn it off), calculated by the buyer's shipping address, shown at checkout, charged only on **single-seller card (Stripe) payments**. Not Pro-gated (compliance feature). No tax is actually charged until the seller adds the US states they're registered in (Stripe returns zero without nexus). Deferred for v1: per-seller multi-merchant tax and refund/tax reversal.

- **Flag (on by default)**: `stripe_connect_accounts.tax_enabled` (column default `TRUE`; getter `COALESCE(..., TRUE)`). `setStripeTaxEnabled(pubkey, enabled)` flips it (`utils/db/db-service.ts`). A guarded one-time migration (a `DO $$` block that only runs while the column's default is still `'false'`) backfills existing accounts to TRUE and switches the default — restart-safe, so it never re-enables a seller who opted out.
- **Settings UI** (`pages/settings/payments.tsx`): "Sales Tax" card, only when `chargesEnabled`. Toggle (defaults on) + US-state registration add/remove + diagnostic status. The "Stripe Tax status" warning only shows once there's ≥1 registration, so on-by-default sellers with no states don't see a premature/scary message. Signs `buildStripeTaxSettingsProof` and POSTs `{pubkey, action, signedEvent, state?, registrationId?}`.
- **Endpoint** (`pages/api/stripe/connect/tax-settings.ts`): signed-event auth (single-use proof, falls back to generic Nostr auth), requires `charges_enabled`. `ensureTaxOriginConfigured` (head-office address from the connected account + `tax_behavior: exclusive`, idempotent) runs on **both** `enable` and `add_registration` — critical because on-by-default sellers add states without ever clicking enable, and a registration with no origin would silently calculate $0. Actions: `status`, `enable`, `disable`, `add_registration` (US state), `remove_registration` (registrations can't be deleted — expired with `expires_at: now`). Always returns the latest combined `{taxEnabled, settingsStatus, settingsStatusDetail, registrations}`.
- **Server-side gating**: `calculate-tax.ts` returns a skip (zero) response unless single-seller + `charges_enabled` + `tax_enabled`; multi-merchant always skips. Since `tax_enabled` is now on by default, the real gate on whether tax is charged is the seller's Stripe Tax registrations (no nexus → Stripe returns zero, caught and treated as $0). `create-payment-intent.ts` independently re-checks `tax_enabled` for the seller before adding `salesTaxSmallest` to the charge (with Stripe-floor handling), and never for multi-merchant. The cart/product cards only trigger the tax-calc effect for single-seller Stripe sellers.
- **Reporting**: `record-tax-transaction.ts` calls `stripe.tax.transactions.createFromCalculation` on the connected account, reading `taxCalculationId` from the **retrieved, succeeded** PaymentIntent's metadata (never client-trusted), idempotent via `taxtxn_<piId>` ("already exists" = recorded). Called best-effort from the single-seller Stripe success handlers; never blocks the order.
- **Order threading**: tax is its **own** line, not folded into displayed order totals (which stay items + discounted shipping per the reported-vs-charged convention). Gift-wrap `["tax", amount, currency]` tag (`utils/nostr/nostr-helper-functions.ts`), `buildTaxSection` in buyer + seller emails (`utils/email/email-templates.ts`, `pages/api/email/send-order-email.ts`), and a "Sales Tax" column in `components/messages/orders-dashboard.tsx`. Threading fires only inside `handleStripePaymentSuccess`, so LN/Cashu orders never carry a tax tag/row.
- **Checkout display**: because tax is charged only on the Stripe path, the "Pay with Card" button amount includes `salesTaxNative`, while Lightning/Cashu/manual-fiat buttons stay tax-free. The order-summary tax line is labeled "Sales tax (card payments)" to explain why non-card buttons show less.
- **Known limitation**: `buildTaxSection` labels the tax amount with the order currency, so a sats-priced listing paid by card could mislabel the USD tax (edge case, deferred).

### Runbook — lifetime member with a stuck recurring subscription

When a seller buys lifetime (Wrangler) access while holding a recurring Herd subscription, we cancel the old subscription best-effort at purchase (`cancelExistingProSubscription`) and auto-retry on every later subscription webhook (`applyStripeSubscriptionToMembership`'s lifetime guard, both in `utils/pro/membership.ts`). If Stripe cancellation keeps failing, the seller could be charged for one more cycle before a retry succeeds — and a truly wedged subscription would never clear on its own.

- **Detect**: every cancel attempt emits a structured log line tagged `[pro_lifetime_lingering_subscription_cancel]` with a JSON payload (`event: "pro_lifetime_lingering_subscription_cancel"`, `outcome: attempt | success | failure`, `source: purchase | renewal_webhook`, `pubkey`, `subscriptionId`, and `error` on failure). Filter logs for that tag (or `"outcome":"failure"`) to surface persistent failures. A `pubkey` showing repeated `failure` outcomes with no following `success` is stuck and needs manual intervention.
- **Alert**: on any cancel `failure`, an admin alert email is sent automatically (`sendProLifetimeLingeringCancelAlert`, mirroring `sendTransferFailureAlert`) with the `pubkey`, `subscriptionId`, failure source, and last error so you don't have to be watching logs. Recipient resolves to the SendGrid verified `from_email` (the operator's own mailbox). The alert is rate-limited to once per day per subscription via a `pro_settings` key `lifetime_lingering_cancel_alert:<subscriptionId>` (timestamp written only after a mail actually sends, so a transient mail failure still re-alerts on the next webhook retry), so a single wedged subscription can't spam an alert on every renewal webhook.
- **Confirm**: in the Stripe Dashboard, look up the `subscriptionId` from the log line and verify it's still `active`/`past_due` (i.e. not already canceled by a retry).
- **Resolve**: cancel the subscription immediately in the Stripe Dashboard (Subscriptions → the sub → Cancel, "immediately"), or via API `stripe.subscriptions.cancel(<subscriptionId>)`. The lifetime grant already nulled `stripe_subscription_id` in our DB, so no DB change is needed — this only stops the live recurring charge at Stripe. If the seller was already wrongly charged for an extra cycle, issue a refund from the Dashboard.

## Donations (platform fee)

- **Field**: Sellers' donation percent lives in Nostr profile JSON under `mm_donation` (was `shopstr_donation` upstream). Defaults to 2.1% when absent. Profile form writes only `mm_donation` and strips stale `shopstr_donation`.
- **Cashu/Lightning**: Donation eCash sent to `process.env.NEXT_PUBLIC_MILK_MARKET_PK`; skipped with a warn if unset.
- **Stripe parity**: `utils/stripe/donation.ts` reads `mm_donation` from cached `profile_events`, defaults to 2.1%, caches per-seller for 5 min, skips when seller equals `NEXT_PUBLIC_MILK_MARKET_PK`, falls back to no fee when cut would be ≥ gross. Wired into:
  - `create-payment-intent.ts` — `application_fee_amount` for single-merchant; embeds per-seller fees in multi-merchant `sellerSplits` metadata.
  - `process-transfers.ts` — withholds cut from each `Transfer.amount` (prefers embedded values, falls back to fresh profile lookup).
  - `create-subscription.ts` / `create-cart-subscription.ts` — `application_fee_percent` on direct-charge subs; `create-invoice.ts` — `application_fee_amount` on direct-billed invoices.
- **Dashboard parity**: Stripe success handlers in `cart-invoice-card.tsx` and `product-invoice-card.tsx` compute donation from cached profile and pass `donationAmountValue`/`donationPercentageValue` into every `sendPaymentAndContactMessage`. `donation_amount` tag emitted via `utils/nostr/nostr-helper-functions.ts` so Stripe orders render the donation row identically to Cashu/Lightning.
- Platform-account selling-to-itself is a no-op everywhere.

## Multi-currency & cart math

- Cart display currency = most common item currency (tiebreak: USD > sats > alphabetical). Mixed carts convert via `@getalby/lightning-tools`. Zero-decimal currencies (JPY/KRW/etc.) handled. Bitcoin/Lightning always sats; Lightning buttons show fiat + sats estimate for fiat-priced products. Sats-only carts show USD estimate on Stripe/fiat buttons.
- `nativeTotalCost` and `nativeCostsPerProduct` are async (`useEffect`+state) for cross-currency conversion.
- `process-transfers.ts` reads currency from the PaymentIntent for multi-merchant transfers; subscription-renewal transfers read it from the invoice. Order messages include `["currency", ...]` and `["amount", ...]` tags. Subscriptions are `pending` until first successful payment activates them via the subscription webhook.
- **Round-up policy**: All conversions and on-the-wire charge math use `Math.ceil` (never `round`/`floor`). Stripe charges below the gateway floor surface a "$0.50 minimum" banner.

## Fiat & multi-merchant fiat

Manual methods: Venmo, Zelle, Cash App, PayPal, Apple Pay, Google Pay, Cash. Multi-merchant fiat: each seller gets their own dropdown, per-merchant instructions/amounts, individual confirmation checkboxes. Order only confirmed when all checkboxes checked. Single-merchant retains the original single-dropdown flow.

## API rate limiting

All public `pages/api/**` endpoints use the in-memory token bucket in `utils/rate-limit.ts` (`checkRateLimit`, `applyRateLimit`, `getRequestIp`) keyed by client IP, with `X-RateLimit-*` headers and `Retry-After` on 429. Per-process buckets — under horizontal scaling the effective ceiling is `N × limit` (intentional coarse DB-pool guard). Webhooks rely on signature + Stripe-event idempotency instead.
