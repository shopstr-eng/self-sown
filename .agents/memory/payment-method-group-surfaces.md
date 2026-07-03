---
name: Payment-method group ordering + Bitcoin opt-out surfaces
description: The surfaces a seller checkout payment-button change must thread through, and the buyer-side fail-safe rules.
---

Checkout payment buttons are grouped into three domain groups:
`StorefrontPaymentMethodGroup = "bitcoin" | "card" | "fiat"` (NWC lives in the
`bitcoin` group). A change to how sellers control payment buttons must thread
through ALL of:

- `packages/domain/src/storefront.ts` — the group type, `DEFAULT_PAYMENT_METHOD_ORDER`, and `orderedPaymentMethodGroups()` (fills missing groups, dedupes, drops invalid).
- `packages/domain/src/seller.ts` normalization — filter/validate the persisted fields.
- `components/settings/shop-profile-form.tsx` — seller UI + both hydrate sites + settingsSnapshot + save assembly.
- BOTH checkout cards: `components/product-invoice-card.tsx` and `components/cart-invoice-card.tsx` render buttons as a `Record<group, ReactNode>` then `order.map()`. Each node needs a stable React key.
- `mcp/tools/write-tools.ts` — agents set the same fields.

**Byte-stable default rule:** persist a field only when it diverges from default
(`acceptBitcoin` emitted ONLY when `=== false`; `paymentMethodOrder` only when it
differs from the default order) so kind:30019 events stay byte-stable.

**Buyer-side fail-safe (never leave a buyer unable to pay):** hide the bitcoin
group only when `acceptBitcoin === false` AND a card OR fiat option is actually
available at that checkout. In the cart, `acceptBitcoin` and the custom order are
per-seller settings, so honor them ONLY for single-seller carts; multi-seller
carts always show bitcoin and use the default order. Card availability differs by
surface: product card = Stripe only (no Square); cart single-seller =
`isStripeMerchant || squareCardEligible`, multi-seller = `allSellersHaveStripe || multiSellerCardEligible`.

Also mirror the fail-safe at save time: only persist `acceptBitcoin:false` when the
seller has a card/fiat method, so the stored value can't drift from the disabled
(checked) checkbox.
