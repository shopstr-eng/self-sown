---
name: Gated capability request isolation
description: gated Stripe capabilities (tap_to_pay_payments) must be requested in their own accounts.update — an inapplicable capability 400s the WHOLE call and silently drops co-requested core capabilities.
---

Stripe rejects `accounts.update` with "Received unknown parameter:
capabilities[tap_to_pay_payments]" when the capability isn't applicable —
platform not enrolled in Tap to Pay (it's a gated Terminal feature enabled
in the Dashboard), or the account country doesn't support it. The rejection
fails the ENTIRE update, so bundling it with card_payments/transfers left
those un-requested too (seen in production on a US Express account;
platform account capabilities list confirmed no tap_to_pay_payments entry).

Rule: request core capabilities (card_payments, transfers) in one update
(failure is real, ok:false); request gated ones (tap_to_pay_payments) in a
separate best-effort call whose failure is logged + reported (tapToPayError)
but never fatal. Implemented in utils/stripe/ensure-capabilities.ts.

**Why:** inapplicable-capability rejections are per-call, not per-parameter.
Also, the platform's own capabilities hash (GET /v1/account) shows which
gated features are enrolled — check it before debugging the capability name
or API version (both were red herrings here: name and clover pin were fine).

**How to apply:** any new capability in ensure-capabilities goes into CORE
only if every seller needs it unconditionally; gated/optional capabilities
get their own isolated call. Tap to Pay self-heals after platform
enrollment: every create-account-link / manage-link hit re-runs the seam.
