---
name: Stripe test-mode E2E harness
description: scripts/e2e-multi-seller-subscription.mjs runs real Stripe test-mode verification; quirks of this Stripe account and sandbox baked in.
---

`scripts/e2e-multi-seller-subscription.mjs` verifies multi-seller recurring-cart payouts against the real Stripe test API (header documents setup). Key learnings, all verified empirically on this Stripe account:

- Run the server as a SECOND standalone instance with env overrides (`PORT=3001 STRIPE_SECRET_KEY=$STRIPE_TEST_SECRET_KEY STRIPE_WEBHOOK_SECRET=<throwaway whsec>`); never swap the workspace's live-key secrets. Refuse `sk_live` in harnesses.
- Webhook events: fetch the real event via API, re-sign with the throwaway whsec, POST through the real route. No test-mode webhook endpoint points at staging, so Stripe never delivers directly.
- Raw card-number APIs are disabled on this account → create payment methods from test tokens. `tok_bypassPending` = card whose funds land in AVAILABLE balance immediately (needed for transfers).
- Connected accounts: custom accounts are blocked until the test-dashboard Connect platform profile is completed; express accounts need hosted onboarding (TOS can't be API-accepted). Two onboarded express test accounts already exist (acct_1UHHZeHV9FUIvCCE, acct_1UHHZhQeYmxHQLVS, transfers-active) — reuse via E2E_ACCOUNT_A/B.
- Test clocks: `customers.list({email})` cannot see clock customers, so the route creates a second clockless customer — clocks are unusable when the route owns customer creation. `billing_cycle_anchor: "now"` generates NO invoice on clover. `invoiceItems` refuse recurring prices. Working renewal simulation: quantity bump + `proration_behavior: "always_invoice"` → real immediately-paid invoice whose lines carry the recurring price ids.
- Detached runs in this sandbox: use `setsid script >log 2>&1 </dev/null & disown` — plain `nohup ... &` children get reaped.

**Why:** these constraints cost several probe rounds to discover; each is undocumented or version-specific.

**How to apply:** reuse the harness and its env-override pattern for any future real-Stripe staging verification; expect the same account restrictions (platform profile, raw card data) to still apply.
