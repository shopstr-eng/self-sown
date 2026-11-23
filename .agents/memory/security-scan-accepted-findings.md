---
name: Security scanner accepted findings
description: Which recurring SAST/HoundDog findings are by-design for this codebase — don't re-triage them from scratch each scan.
---

Recurring scanner findings that are ACCEPTED (by design) in this codebase:

- HoundDog "Encryption Key sent to Local Storage" (CRITICAL): ciphertext-only NIP-49 storage is intentional. This exemption does not cover a serialized object containing an unlock passphrase alongside the ciphertext.
- HoundDog "Payment Method sent to Stripe": Stripe.js tokenization is the intended flow; card data never touches app JS.
- HoundDog "…sent to Session Storage" on orderSummary: payload holds title/image/amount/currency/payment-method ENUM/orderId — no card or address data.
- SAST tainted-redirect in pages/api/email/flows/click.ts: destination is HMAC-signed and http/https-validated inside the token; query input is never redirected to directly.
- SAST generic_postgres_string in utils/self-host/export-bundle.ts: a placeholder in the generated self-host .env template, not a credential.

**Why:** these re-fire on every scan; each was investigated and confirmed benign (2026-09). A repeated rule label can still cover a different, unsafe payload, so exemptions must stay narrow.

**How to apply:** exemptions apply only to the verified payload and dataflow, not a rule label or destination. Re-check changed serialization and credential-bearing siblings before dismissing a repeated alert. Note the OAuth lesson this produced: the authorize-time redirect_uri cookie (validated same-origin at write time) is the trusted origin anchor for the credential-carrying success redirect — never the configured site URL (self-host misconfig sends credentials off-origin) and never a bare Host header. One narrow exception: Apple's cookie-less form_post falls back to the request host, which is proof-backed — a successful token exchange byte-matching the provider-registered redirect_uri must precede the credential redirect.
