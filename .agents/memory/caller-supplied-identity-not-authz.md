---
name: Caller-supplied identity is not authorization
description: Comparing a request's own seller_pubkey/pubkey field against a DB row proves nothing — identity must come from a verified signature
---

A check like `if (row.seller_pubkey !== req.body.seller_pubkey) return 403` is NOT an access check: the attacker supplies both values, so they always "match". Same for `requireProEntitlement(seller_pubkey)` — it checks the _victim's_ membership, never the caller's identity.

**Why:** The email-flows API (`pages/api/email/flows/*`) used exactly this pattern — anyone could read, edit, toggle, or delete any Pro seller's email flows (including the subject/body_html of mail sent from the seller's DKIM-authenticated domain) just by passing the victim's pubkey. Found in an auth-coverage audit after the get-subscriptions hole.

**How to apply:**

- When auditing a route, ask "who chose this identity value?" If the answer is "the caller", the check is decorative.
- The fix pattern: `verifyNip98Request(req, method, body)` (utils/nostr/nip98-auth.ts) and derive identity from `auth.pubkey`; keep the caller-supplied field only as a fail-closed cross-check (`!== auth.pubkey → 403`).
- Client signing contract: sign the EXACT absolute URL (query string included for GET/DELETE) and the exact serialized body bytes. Web: `createNip98AuthorizationHeader(signer, window.location.origin + path, method, bodyStr)`; mobile: same helper from apps/mobile/lib/nip98.ts with a SellerSession. For DELETE, set `req.body = undefined` before verifying so the payload check skips.
