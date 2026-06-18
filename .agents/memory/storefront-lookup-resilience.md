---
name: Storefront / custom-stall lookup resilience
description: Rules for the client-side shop resolution on /stall pages so transient hiccups and stale cache don't break page state
---

# Custom-stall loading resilience

Custom-domain storefronts ("custom stalls") resolve a shop pubkey by hitting `/api/storefront/lookup` (200 `{pubkey, shopSlug|slug}` / 404 / 5xx). The page surfaces this through a shared hook + helper (`utils/storefront/use-storefront-lookup.ts`, `storefront-lookup-client.ts`) and the edge `host-cache.ts`. The recurring failure modes and their fixes:

## Only cache HTTP 404 negatives — never transient failures

The edge `host-cache` and the client helper must treat ONLY a real `404` as a definitive negative (domain/slug unconfigured, or a lapsed/hidden Pro seller). Every 5xx / 429 / 408 / network/TLS error is TRANSIENT and must be retried, not cached and not turned into "not found".

**Why:** poison-caching any failure for the negative-TTL window pinned every visitor to the "Domain Not Configured" / "Stall Not Found" placeholder after a single DB blip, even though the stall was fine. A single-shot client lookup with a 15s timeout-to-not-found had the same effect per device.

**How to apply:** edge negative cache gated on `r.status === 404` only (`cache: "no-store"`); client `lookupStorefront` returns `resolved | not_found(404, terminal) | transient_error(retry w/ jittered backoff)`; the UI shows a retryable error (auto-retry + self-heal on `online`/`focus`/`visibilitychange`), never a permanent not-found, on transient failure.

## Bind resolved state to the route identity, and gate on router.isReady

A client lookup hook for a route-bound resource must (a) tag the resolved pubkey with the identity (`kind:value`, e.g. `domain:naughtygoat.co`) and render `resolved` only when that tag equals the CURRENT route identity, and (b) accept a `ready` flag (`router.isReady`) and stay in `loading` while false.

**Why:** storing a bare `pubkey` let a value from a previous slug/domain linger for a frame on client-side navigation (the "shows old data from a previous domain" symptom), and an SSR/prop seed from stale HTML could resolve a mismatched route. Separately, before `router.isReady` the query param (`domain`/`slug`) is momentarily empty, and treating empty as not_found flashed "Domain Not Configured" on pages with no getServerSideProps (the custom-domain placeholder).

**How to apply:** keep resolved state as `{id: "kind:value", pubkey}`; derive the active pubkey as `resolved.id === currentIdentity ? resolved.pubkey : ""`; re-seed SSR pubkey tagged with the current identity on identity change; bump a request-id ref in the reset-effect cleanup so a late in-flight settle can't write state after unmount. Terminal not_found only when `ready && api 404 && local (ShopMap) fallback not pending && no match`.
