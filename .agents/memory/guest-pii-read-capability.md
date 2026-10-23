---
name: Guest PII reads need an unguessable capability
description: Unauthenticated guest lookups of buyer data (orders, subscriptions, addresses) must require an unguessable provider ID, never email alone or the sequential row id.
---

When a read endpoint serves rows containing buyer PII (shipping address, email, order history) to users WITHOUT a Nostr session (guest flows), authentication options are:

1. Signed Nostr proof when the caller has a signer (the standard `verifySignedHttpRequestProof` scheme, with the queried identity == proof pubkey).
2. For true guests: require an unguessable capability the buyer already possesses — e.g. the Stripe `sub_...` subscription id from their receipt — matched server-side, returning only matching rows.

**Never** accept: email alone (public knowledge), or the sequential integer row id (enumerable). A client-side filter over an unauthenticated full-row fetch is not a control — the hole is the fetch, not the filter.

**Why:** a read endpoint that skips this leaks buyer PII (shipping address, order history) to anyone who knows or guesses a public identifier. Email alone is public knowledge; the sequential row id is enumerable.

The capability is only usable if guests actually receive it: buyer-facing confirmation/renewal emails must render the full provider ID, and there must be a verified recovery path (server emails the ID to the address on file) for guests who lost it.

**How to apply:** when adding or auditing a guest-facing read of buyer data, check what the route returns (`SELECT *` is the tell) and require either a signed proof or a provider-issued unguessable ID bound server-side. Sibling-read audit rule from paywall-sibling-endpoints.md applies: grep the DB accessor for every route that exposes it.
