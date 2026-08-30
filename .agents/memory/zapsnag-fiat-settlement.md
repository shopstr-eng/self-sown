---
name: ZapSnag fiat settlement
description: Display and charge rules for public kind-1 ZapSnag listings priced outside sats.
---

ZapSnag listings keep the seller's listed amount and currency in every buyer-facing display and in order metadata. Only the amount passed to the Lightning zap is converted to sats.

**Why:** Treating a fiat number as sats both misrepresents the listing and undercharges the buyer. Overwriting order metadata with the converted amount also makes seller records disagree with the public offer.

**How to apply:** Parse supported fiat currencies and decimal prices without coercing them to sats. Immediately before creating the zap, bypass conversion for sats and convert every other currency using a live rate. Reject invalid or unavailable conversions before creating or paying an invoice.
