---
name: Fetching Apple's entitlement-gated Box toolkits
description: How to programmatically download assets from Apple's password-protected Box marketing-toolkit shares (Tap to Pay etc.) from this sandbox.
---

Apple delivers entitlement-gated marketing toolkits (e.g. Tap to Pay on iPhone Marketing Toolkit) as password-protected Box shared links emailed to the Apple Developer Account Holder.

**Why:** The `/s/<hash>` page returns HTTP 403 — that is Box's "password required" app shell, NOT a bot block (the "captcha"/"Blocked" strings in it are incidental). No headless browser or captcha solving is needed.

**How to apply:**
1. Ask the user for the share link; request the share password via `requestSecrets` (never in chat).
2. `GET https://<host>.box.com/s/<hash>` with a cookie jar; extract `"requestToken":"..."` from the HTML.
3. `POST` the same URL with form fields `password` + `request_token` (cookie jar on) — a 200 with a larger page means unlocked.
4. Browse folders by GETting `https://<host>.ent.box.com/s/<hash>/folder/<folderId>` with cookies; each page's HTML embeds an `items` JSON with `typedID` (`d_*` folder, `f_*` file), name, and `itemSize`.
5. Download a file via `https://<host>.ent.box.com/index.php?rm=box_download_shared_file&shared_name=<hash>&file_id=f_<id>` (302s to a signed public.boxcloud.com URL; supports `-L` and range probes).

Toolkit notes: region dirs like `US-EN` contain Product Assets / Marketing Templates / Marketing Guide & Copy Blocks / Videos. Composed device artwork ships as layered PSDs only ("Screen Images" = screen-resolution, "Hi-Res" = print); `magick file.psd[0] -background white -flatten` yields the merged composite. Apple forbids cropping/recoloring/overlays; format conversion and scaling are fine.
