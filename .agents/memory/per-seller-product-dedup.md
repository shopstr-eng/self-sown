---
name: Per-seller product read must dedup by address
description: Why the custom storefront showed stale duplicate listings, and the read-path rule that fixes it.
---

# Per-seller product read must dedup by (pubkey, d-tag)

`product_events` keeps EVERY cached version of a listing (the row `id` is the PK;
edits/republishes append new rows, they do not replace). So any read path that
must show "the current catalog" has to dedup to the latest version per
addressable id `(pubkey, d-tag)`.

The marketplace read (`fetchAllProductsFromDb`, no pubkey) already dedups via
`DISTINCT ON (pubkey, d_tag) ORDER BY created_at DESC`. The per-seller read
(`fetchProductsByPubkeyFromDb`) used to just delegate to the non-deduped
`fetchCachedEvents`, so it returned every stale version. That fed the custom
storefront, the stall SSR JSON-LD ItemList, the UCP catalog search/lookup, and
the listing-page siblings — all of which then showed duplicate/old listings.

**Rule:** `fetchProductsByPubkeyFromDb` must dedup by `(pubkey, d-tag)` keeping
the latest `created_at`, mirroring `fetchAllProductsFromDb` but scoped to one
pubkey. Use `COALESCE(d-tag, id)` so a malformed/no-d-tag event stays
individually addressable, break created_at ties deterministically (`, id DESC`),
and apply `LIMIT/OFFSET` AFTER the dedup subquery, not over the raw rows.

**Why the custom storefront is the visible victim:** `_app.tsx` skips the global
deduped `fetchAllPosts` on storefront routes (`!isStorefrontRoute`).
`fetchStorefrontData` instead loads `/api/db/fetch-products?pubkey=` and renders
it immediately (`editProductContext(productsFromDb, true)`). Its later relay
merge collapses same-address dupes into a `pubkey:d-tag` map ONLY when relays
return products; the relay-empty `else` and the relay-error `catch` branches
re-emit the raw DB list, so when a seller's relays are slow/down the duplicates
persist permanently. Fixing the DB function fixes the initial render AND both
fallback branches at once — no client change needed.

**What dedup-by-address CANNOT fix:** two listings with the same TITLE but
different `d` tags are distinct addressable products (e.g. a legacy d-tag scheme
vs the SHA256-of-name one in `product-form.tsx`). They are not stale cache;
merging them by title would break Nostr addressability. Resolve as seller data
cleanup (delete the orphan via the normal deletion path), never auto-merge.

**How to apply:** when adding any new per-seller catalog/display/canonical-URL
consumer, read through a deduped accessor; never expose raw `fetchCachedEvents`
versions for display. If a true version-history read is ever needed, add a
separate explicit history function rather than un-deduping this one.
