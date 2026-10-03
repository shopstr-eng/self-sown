---
name: Custom domain always overrides stall slug
description: User-stated product rule — any seller-facing share/storefront link must prefer the seller's verified custom domain over /stall/<slug> URLs.
---

When a seller has a custom domain connected (verified row in `custom_domains`),
links we generate for sharing their storefront must use `https://<domain>`,
never the platform `/stall/<slug>` URL. The slug URL is only a fallback when
no verified domain exists.

**Why:** the user stated this as a standing rule ("that seller has a custom
domain connected — that should always override any stall slug"), 2026-10-03,
while reviewing affiliate share links.

**How to apply:** resolve every generated seller-storefront link in the order
verified custom domain → platform stall slug → site root, via the shared
server/client resolvers rather than re-deriving URLs per surface. On a custom
domain the stall is root-mapped, so path segments drop the `/stall/<slug>`
prefix. Exception: affiliate invite links stay on the platform origin because
`/affiliate/<token>` is not served on custom domains.

**Browser share constraint:** `navigator.share` must be invoked synchronously
inside the click's transient user activation — awaiting a network lookup first
makes the sheet fail with `NotAllowedError`. Preload share-URL data before the
click and read it synchronously; on a cold cache fall back to the platform URL
and let the prefetch serve the next click; recover from genuine share failures
with a visible clipboard-copy fallback (user-dismissed AbortError stays silent).
