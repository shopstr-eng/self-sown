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

## Same bug class for POSTS (the feed, not the metadata)

`fetchCommunityPosts` had the identical flaw one layer down: it read DB-cached
posts/approvals first, but then ALWAYS blocked on `nostr.fetch` relay calls.
`nostr.fetch` wraps `newPromiseWithTimeout` which **rejects after 60s** on
timeout. The relay pool is warm on the marketplace full-load (EOSE arrives fast)
but cold/slow on the storefront fast-path, so the relay fetch rejected/hung; the
outer `catch` did `reject(error)`, discarding the already-fetched DB posts, and
`CommunityFeed.loadPosts` had no try/catch so `setIsLoading(false)` never ran →
permanent "Loading posts..." spinner on `/stall/*/community` while
`/communities/[naddr]` was fine.

**Fix:** (1) hoist the DB maps above the try and resolve from them
(`resolveFromCache`) in the no-relay branch AND the outer catch — a relay
timeout/error must degrade to cached posts, never reject. (2) Progressive render:
optional `onCachedPosts` callback fired right after the DB seed (only when the
annotated cache is non-empty) so the feed paints immediately, then the awaited
relay result enriches it — same DB-seed-then-relay-update shape as
`communityPromise`. (3) `loadPosts` got try/catch/`finally { setIsLoading(false) }`
as a backstop (also covers the moderator `fetchPendingPosts` path).

**How to apply:** any feed/list that reads cache+relays must never let the relay
fetch's rejection throw away cache data already in hand, and its loading flag
must clear in `finally`. `nostr.fetch` rejecting on a 60s timeout is the trap.

**Display gate (unchanged, intentional):** `storefront-layout.tsx` shows
`sellerCommunity = first c where c.pubkey === shopPubkey` from the global
`CommunityContext`, and the storefront relay filter uses `authors:[shopPubkey]`.
A community authored by a DIFFERENT pubkey than the slug-resolved shop pubkey is
still hidden on the storefront by design (seller-owned-community semantics);
changing that is a separate product decision, not a bug.
