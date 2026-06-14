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

- **Spoofing rule (the durable one): only attach a custom seller from-address when EITHER the
  request is authenticated as that seller (resolve from the authed pubkey, NEVER a body field)
  OR the recipient is the seller's own server-resolved address. Otherwise use the global
  sender.** A seller's domain is DKIM-authenticated, so sending from it on a public /
  body-supplied-recipient path lets anyone emit domain-aligned spoofed mail to arbitrary
  addresses — a phishing escalation, not just an open relay.
- Custom-from IS used on: order-confirmation/new-order (`send-order-email.ts`), flow emails +
  one-time sends (`flows/process.ts`), flow test sends (`flows/[flowId]/send-test.ts`,
  NIP-98-authed → resolve from authed pubkey) and order/shipping updates
  (`send-update-email.ts`, NIP-98-authed → authed pubkey); plus product inquiries
  (`send-inquiry-email.ts`) and return/refund requests (`send-return-request-email.ts`) whose
  recipient is the seller's OWN notification email (can't be redirected to a third party).
- Custom-from is DELIBERATELY NOT used on subscription lifecycle (`send-subscription-email.ts`,
  unauthenticated + has buyer-initiated callers + body recipient) or the storefront popup
  welcome (`storefront/popup-capture.ts`, public buyer-facing + body recipient) — they stay on
  the global sender. Platform→user emails (recovery/admin/affiliate/pro-receipt/contact-form,
  systemic Stripe payment-failure in `stripe/webhook.ts`) also stay global. Don't add custom-from
  to any of these without first satisfying the spoofing rule above.
- Any NEW caller that passes a custom from-address MUST go through `sendEmail()`'s
  retry-on-403 path; never call the raw SendGrid send with a seller address and no global
  fallback.
- Never widen `isValidFromEmail` beyond exact host==domain (no subdomain/suffix matching)
  or sellers could spoof a from-address SendGrid hasn't authenticated.
- Writes are Pro-gated (`requireProEntitlement`) + `verifyNostrAuth` binding
  `"email-sender-domain-write"`; keep that binding string in sync with the
  `SellerActionAuthTag` union in `packages/nostr/src/index.ts`.
