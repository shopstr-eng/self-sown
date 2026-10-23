---
name: Mobile membership checkout redirect rules
description: Redirect constraints for browser-sheet payment flows in the mobile app (hosted Stripe Checkout vs Billing Portal)
---

The mobile app opens hosted Stripe pages in an expo-web-browser sheet for membership purchase/management.

**Rule:** Checkout success/cancel URLs may use the `selfsown://` custom scheme (auto-closes the sheet via openAuthSessionAsync); the Billing Portal return_url stays https-only server-side — verify Stripe accepts custom schemes before ever relaxing that.

**Why:** Stripe honors custom-scheme redirects for Connect account links and Checkout success_url, but portal return_url support is unverified, so the portal flow refetches status when the sheet is dismissed instead.

**How to apply:**

- Never treat openAuthSessionAsync resolving (type "success") as proof of payment — the cancel deep link also matches the redirect base and resolves identically. Parse the redirect URL's status param first.
- Custom-scheme deep links render as scheme://path on some platforms and scheme:///path on others; parse query params tolerantly (regex), not via strict URL path matching.

## Never Linking.createURL for Stripe redirect URLs

Stripe rejects `selfsown:///pro-return?...` (triple slash, empty host) with "Not a valid URL" but accepts `selfsown://pro-return?...`. Linking.createURL emits different forms per platform, so the same build worked on iOS and failed on Android (or vice versa). createProCheckoutRedirectUrl/BaseUrl are fixed strings now; the parser stays regex-based since old builds may send either form.
