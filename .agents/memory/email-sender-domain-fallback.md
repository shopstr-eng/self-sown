---
name: Custom email sender-domain fail-closed fallback
description: How seller-owned SendGrid sender domains must degrade so a misconfigured domain can never drop an email.
---

Pro/Herd sellers can send flow + order-confirmation/new-order emails from their OWN
SendGrid Domain-Authenticated domain (table `email_sender_domains`, util
`utils/email/sendgrid-domain-auth.ts`, UI under EMAIL settings mirroring the storefront
custom-domain feature).

**Rule:** the custom from-address is _advisory only_. It is used to send mail ONLY when
all three hold — SendGrid reports the domain `valid===true`, a `from_email` is stored, and
the from-email host exactly equals the verified domain. Anything else falls back to the
global verified sender.

Two layers enforce this, and BOTH must stay intact:

1. `resolveSellerSenderEmail(pubkey)` returns the custom address only under the conditions
   above and wraps everything in try/catch → returns `null` on any error (DB down, bad
   row). It can never throw and never returns an unverified address.
2. `sendEmail()` takes an optional trailing custom from-address and, on a SendGrid 403
   _verified-sender_ error (`isVerifiedSenderError`), retries the send ONCE with the global
   verified sender. So even if a domain de-verifies at SendGrid after we cached it valid,
   the email still goes out from the global sender.

**Why:** HARD CONSTRAINT for this feature was "never break existing email delivery." A
seller's domain can be half-configured, expire, or get revoked at SendGrid independently of
our DB. Treating the custom sender as best-effort + always-retry-global means a broken
seller domain degrades to the working global sender instead of silently dropping
transactional/flow mail.

**How to apply:**

- Only order-confirmation/new-order + flow emails (`send-order-email.ts`,
  `flows/process.ts`) thread the custom from-address. Recovery/admin/affiliate/pro/
  order-update/subscription emails intentionally stay on the global sender — do not add the
  custom sender to them without re-checking the fallback path.
- Any NEW caller that passes a custom from-address MUST go through `sendEmail()`'s
  retry-on-403 path; never call the raw SendGrid send with a seller address and no global
  fallback.
- Never widen `isValidFromEmail` beyond exact host==domain (no subdomain/suffix matching)
  or sellers could spoof a from-address SendGrid hasn't authenticated.
- Writes are Pro-gated (`requireProEntitlement`) + `verifyNostrAuth` binding
  `"email-sender-domain-write"`; keep that binding string in sync with the
  `SellerActionAuthTag` union in `packages/nostr/src/index.ts`.
