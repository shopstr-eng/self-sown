---
name: tap_to_pay_payments is not a real capability
description: Tap to Pay rides on card_payments — there is no tap_to_pay_payments capability; requesting it 400s and once sank core capability requests in a shared accounts.update.
---

Stripe has NO requestable `tap_to_pay_payments` capability. Tap to Pay on
iPhone works through the plain `card_payments` capability on the connected
account. Confirmed two ways: a live contactless Tap to Pay charge succeeded
on an Express account whose capabilities had only card_payments (no
tap_to_pay entry anywhere — platform or connected), and Stripe support
stated the capability does not exist.

Requesting it via `accounts.update` 400s with "Received unknown parameter:
capabilities[tap_to_pay_payments]", and that rejection fails the ENTIRE
update — bundling it with card_payments/transfers once left those
un-requested on a real seller (production incident).

`utils/stripe/ensure-capabilities.ts` now requests ONLY card_payments +
transfers (one update, failure is real). A regression test asserts no
accounts.update call ever contains tap_to_pay. An earlier version of this
file claimed the capability was real but platform-gated — that was wrong;
the "platform enrollment in the Dashboard" trail was a dead end (no such
settings exist for a platform where Terminal is already active).

**Why:** unknown-parameter rejections are per-call, not per-parameter, so a
bogus capability poisons everything bundled with it. Per-seller Tap to Pay
still requires the seller to accept Apple's ToS (automatic at first reader
connect) and a Terminal location (auto-created by
utils/stripe/ensure-terminal-location.ts) — neither is a capability.

**How to apply:** never request tap_to_pay_payments (or any capability you
haven't seen listed on a real account of the same type). If a seller can't
Tap to Pay, check card_payments status, Terminal location, and the Apple
entitlement/ToS flow — not capabilities.
