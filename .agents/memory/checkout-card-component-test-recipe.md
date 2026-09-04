---
name: Checkout-card component test recipe
description: Non-obvious seams for driving product-invoice-card / cart-invoice-card through a real Cashu escrow payment in jsdom tests
---

Driving the two giant checkout cards (`product-invoice-card.tsx`, `cart-invoice-card.tsx`) through a full Cashu escrow payment in jsdom has several non-obvious seams. Canonical working examples: `__tests__/components/{product,cart}-invoice-card-escrow-backup.test.tsx`.

- **Price products in sats.** With a fiat currency the card runs the non-resilient `getSatoshiValue` (a module-mock of `@/utils/stripe/currency` does NOT intercept it) — the real fetch fails, the price is NaN, and `NaN > 0` silently skips the whole seller/escrow block while the payment still "succeeds".
- **`shippingType: "N/A"` (product) / `"Pickup"` (cart)** auto-selects the contact order form, which is valid with no fields — anything else hits react-hook-form required-field gating that stubbed HeroUI Inputs can't satisfy.
- **jest.mock factories run before the test file's const initializers.** Referencing a const mock directly inside a factory (`safeSwap: safeSwapMock`) throws "Cannot access before initialization" — defer evaluation with a closure (`safeSwap: () => safeSwapMock()`). The closure must not spread `unknown[]` into a zero-arg-impl `jest.fn` (TS2556) — just call it with no args.
- **The cart path uses real cashu-ts v4 `Amount` objects**: `proof.amount.toNumber()`, `Amount.from(proof.amount)`, and a SYNCHRONOUS `wallet.getFeesForProofs()` returning an Amount. Fixture proofs need `amount: Amount.from(n)` (import it from the mocked `@cashu/cashu-ts` — it survives via `...actual`); plain numbers or `{toNumber}` hybrids throw "Unsupported amount input type". The product card path uses plain numbers — the two cards differ.
- **Module split:** cards import `registerEscrowCommitmentWithServer` from `@/utils/cashu/escrow-checkout` but `publishEscrowBackup`/`describeEscrowBackupWarning` from `@/utils/cashu/escrow-backup`. Mocking the wrong module silently lets the real call through.
- **The cart requires a `satPrices` prop covering every product** (fail-closed per-item check); the product card computes it internally.
- **Real bech32 everywhere**: SignerContext npub and the `generateKeys` mock must return real npub/nsec — the inquiry-DM path `nip19.decode`s them and fake strings throw deep in the payment flow.

**Why:** each of these cost a debug cycle and fails silently (payment "succeeds" without touching the escrow seam) rather than erroring loudly.

**How to apply:** copy the escrow-backup test files as the starting harness for any new checkout-card component test; change only the seam under test.
