---
name: Capturing marketing screenshots of milk.market
description: Which production pages actually render content in an external screenshot vs. capture as a loading spinner
---

When asked to "refresh app screenshots" or add product imagery to marketing pages (landing, producer-guide), only the SSR'd storefront route `/stall/[slug]` renders its products in an external (Firecrawl `screenshot type=external_url`) capture — storefront product data is server-rendered from Postgres. `/marketplace`, `/marketplace/[slug]`, and `/listing/[id]` fetch from Nostr relays client-side, so a screenshot captures the loading spinner (relay fetch isn't done at capture time, and the tool has no wait-control).

**Why:** most product/listing pages can't be screenshotted cleanly; the storefront is the only reliable source of a real-products image. Pick a seller with real listings AND uploaded images (e.g. `freemilk`) — empty stalls render "No products available yet."

**How to apply:** for a live products view, screenshot `/stall/<seller>`.

**External screenshot tools vs. a controlled browser:** the built-in `screenshot type=external_url` (Firecrawl) tool can only capture anonymous, already-rendered pages — it has no login, modal, or wait control, so authenticated/interactive screens (sign-in modal, keys/profile/wallet pages, order chats, listing-creation forms) come out blank or as spinners. These ARE capturable with a controlled local browser instead: install chromium via the package tools, drive Puppeteer against production, inject NIP-49 auth into localStorage to reach signed-in pages, open the target modal/route, then post-process the PNG with `sharp` (crop/resize to match sibling image dimensions). Remember to uninstall chromium and restore any capture-time env changes afterward — they are out of scope for the committed diff.
