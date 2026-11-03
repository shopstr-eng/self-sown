---
name: App-scheme redirect URLs vs Stripe
description: Stripe's API rejects custom URL schemes in return/refresh URLs; mobile deep links must be bounced through an https route that 302s into the app scheme.
---

Stripe API redirect parameters (accountLinks return_url/refresh_url, and any
other hosted-flow URL) must be http(s). Handing Stripe a custom app scheme
(selfsown://, milkmarket://) fails with `url_invalid: "Not a valid URL"`.

Verified live 2026-11-03: mobile Stripe Connect onboarding was broken for new
accounts — the route's own allowlist accepted selfsown:// and passed it raw to
accountLinks.create, which 400'd and surfaced as a 500 "Failed to create
account link". Each retry created ANOTHER duplicate Express account (create
succeeded, link step failed).

**Why:** the route allowlist (isAllowedPlatformRedirectUrl in
utils/site-url.ts) deliberately permits custom schemes because they can only
deep-link into the payer's own app — but that policy is about redirect SAFETY,
not about what Stripe's API accepts. Both must hold: validate for safety, then
translate for Stripe.

**How to apply:** any caller-supplied redirect URL headed to a Stripe API call
must go through toStripeRedirectUrl (utils/stripe/app-return-url.ts) after
validation — https passes through, custom schemes are wrapped in
/api/stripe/connect/app-return?to=... which 302s into the app scheme
(ASWebAuthenticationSession/Safari intercept the 302 and return to the app).
The bounce route accepts ONLY custom schemes (never https targets) so it can't
become an open web redirector. When adding a new Stripe hosted-flow endpoint,
grep for sibling routes that build accountLinks/portal sessions — they all
need the same treatment.
