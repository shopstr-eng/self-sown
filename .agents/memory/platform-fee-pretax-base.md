---
name: Platform fee must be computed on the pre-tax base
description: Donation/application_fee must use items+shipping, never items+shipping+tax
---

When a Stripe direct charge includes sales tax, the platform fee
(`application_fee_amount` / donation cut) must be computed on the **pre-tax
base** (items + shipping), not on the tax-inclusive charge total.

**Why:** Sales tax is money collected on the seller's behalf for them to remit
to the state — it is never platform revenue. If the donation/application fee is
taken as a percentage of `items+shipping+tax`, the platform skims a slice of
the buyer's tax, leaving the connected seller short of the tax they owe. It
also diverges from the client-side fee display, which is computed pre-tax.

**How to apply:** In `create-payment-intent.ts` the charge `amount` is built as
`amountInSmallestUnit += taxAddSmallest`, so any fee math must subtract it back
out first (`donationBaseSmallest = amountInSmallestUnit - taxAddSmallest`) and
pass that to `resolveDonationCut`. The PaymentIntent `amount` still carries the
tax (it is collected, just not fee'd). Multi-merchant carts set tax = 0, so
their per-split fee math is unaffected. Same rule applies to any future
platform-fee surface that runs after tax is folded into the total.
