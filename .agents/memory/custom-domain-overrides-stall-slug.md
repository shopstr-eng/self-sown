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

**How to apply:** any code that builds a seller's public storefront URL
(share buttons, invite/affiliate links, emails, canonical tags) should resolve
in order: verified custom domain → platform stall slug → site root. First
implemented in `/api/affiliates/self-stats` (`storefrontUrl`); other surfaces
may still need aligning.
