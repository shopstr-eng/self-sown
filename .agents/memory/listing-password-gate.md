---
name: Listing password gate is anti-bot friction, not security
description: The LISTING_PASSWORD gate is a deliberate human/manual-action check whose value is intentionally shown to users; do not "harden" it as a secret.
---

The "Enter Listing Password" gate (env `LISTING_PASSWORD`, storage key `PASSWORD_STORAGE_KEY`) is **intentionally not a security boundary**. It only exists to make a seller perform a manual, human action before their pubkey is recorded via `recordAuthedSeller` (marketplace visibility). The endpoint `/api/validate-password-auth` deliberately returns the password verbatim so each prompt can display it ("Enter <password> to get started."), and the inputs use `type="text"` (not `password`).

**Why:** the user explicitly asked to reveal the password — the goal is friction against non-targeted automation, not access control. A future agent seeing "unauthenticated endpoint returns the password" must NOT treat it as a leak to patch; that would undo the requested behavior. (Any script can still pass the gate in two calls; that is accepted. Rate limits 30/min auth + 10/min validate still apply.)

**How to apply:** the SAME gate is duplicated across THREE surfaces that must stay in sync — `components/stall/stall-feed.tsx`, `components/settings/shop-profile-form.tsx` (storefront settings), `pages/settings/community.tsx` ("Enter Vendor Password"). Each fetches `/api/validate-password-auth`, stores a `*PasswordHint`, and POSTs to `/api/validate-password`. Change one → change all three. No other callers exist (mobile app has no such flow).
