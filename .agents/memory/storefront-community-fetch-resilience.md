---
name: Storefront community fetch resilience
description: Why the storefront community tab went blank on stalls while the marketplace still showed the community, and the DB-first ordering that fixes it.
---

# Storefront community fetch must mirror the marketplace ordering

The storefront community fetch (`fetchStorefrontData`'s `communityPromise` in
`utils/nostr/fetch-service.ts`) and the marketplace fetch (`fetchAllCommunities`
in the same file) both read the same two sources: the Postgres cache
(`/api/db/fetch-communities`) and relays (`kind 34550`, `#t: milkmarket`). They
must follow the SAME ordering or they diverge.

**Rule:** fetch the DB cache FIRST in its own try/catch, seed the context early
(only when `size > 0`, so a relay-only community doesn't flash an empty state),
THEN fetch relays in a SEPARATE try/catch. On a relay error, re-publish the
DB-seeded map — never `editCommunityContext(new Map(), false)`.

**Why:** the storefront path used to await the relay fetch FIRST inside the
outer `try`, with the DB fallback after it. A transient relay timeout (varies by
device/network) threw, jumped to the outer `catch`, and wiped the community to an
empty map BEFORE the DB fallback ever ran. Result: the same community showed on
the marketplace `/communities` tab (read from the DB cache) but the seller's
custom stall (`/stall/*` or custom domain) loaded a spinner then said "No
community has been created yet." The marketplace path never had this bug because
it seeds from the DB before touching relays.

**How to apply:** any time two code paths read the same cache+relay sources for
the same data, give the cache its own guarded fetch that sets state first; a
relay/network error must degrade to cached data, never overwrite it with empty.
This is the same meta-lesson as storefront-lookup-resilience (transient source
must not clobber cached good data).

**Display gate (unchanged, intentional):** `storefront-layout.tsx` shows
`sellerCommunity = first c where c.pubkey === shopPubkey` from the global
`CommunityContext`, and the storefront relay filter uses `authors:[shopPubkey]`.
A community authored by a DIFFERENT pubkey than the slug-resolved shop pubkey is
still hidden on the storefront by design (seller-owned-community semantics);
changing that is a separate product decision, not a bug.
