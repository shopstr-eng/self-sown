---
name: Fetching Apple's entitlement-gated Box toolkits
description: How to programmatically download assets from Apple's password-protected Box marketing-toolkit shares (Tap to Pay etc.) from this sandbox.
---

Apple delivers entitlement-gated marketing toolkits (e.g. Tap to Pay on iPhone Marketing Toolkit) as password-protected Box shared links emailed to the Apple Developer Account Holder.

**Why:** The `/s/<hash>` page returns HTTP 403 — that is Box's "password required" app shell, NOT a bot block (the "captcha"/"Blocked" strings in it are incidental). No headless browser or captcha solving is needed.

**How to apply:**
1. Ask the user for the share link; request the share password via `requestSecrets` (never in chat). It may already be an env var (e.g. BOX_TOOLKIT_SHARE_PASSWORD) — check the shell env first.
2. `GET https://<host>.box.com/s/<hash>` with a cookie jar (`-L`; it 301s to `<host>.ent.box.com`); extract `"requestToken":"..."` from the HTML.
3. `POST` to the **ent host** URL (`https://<host>.ent.box.com/s/<hash>`) with form fields `password` + `request_token` (cookie jar on) — POSTing to the plain host 403s after the redirect. A 302 back to `/s/<hash>` means unlocked; GET it to see the folder listing.
4. Browse folders by GETting `https://<host>.ent.box.com/s/<hash>/folder/<folderId>` with cookies; each page's HTML embeds an `items` JSON with `typedID` (`d_*` folder, `f_*` file), name, and `itemSize`.
5. Download a file via `https://<host>.ent.box.com/index.php?rm=box_download_shared_file&shared_name=<hash>&file_id=f_<id>` (302s to a signed public.boxcloud.com URL; supports `-L` and range probes).

Toolkit notes: region dirs like `US-EN` contain Product Assets / Marketing Templates / Marketing Guide & Copy Blocks / Videos. Composed device artwork ships as layered PSDs only ("Screen Images" = screen-resolution, "Hi-Res" = print); `magick file.psd[0] -background white -flatten` yields the merged composite. Apple forbids cropping/recoloring/overlays; format conversion and scaling are fine.

Pulled from the Sept 2026 US share: the Logo and Icon assets (Apple Pay mark SVG + black/white lockup SVGs committed in `apps/mobile/assets/tap-to-pay/logo/`; EPS print variants and Apple Wallet icon TIFFs left on Box) and the Copy and Legal Disclaimers docx (kept in `attached_assets/`, which is gitignored, and transcribed into `apps/mobile/lib/tap-to-pay-marketing-copy.ts`). Still on Box only: Marketing Guide + What's Changed PDFs (~23MB each, kept out of git), Print Images, and Videos folders.
