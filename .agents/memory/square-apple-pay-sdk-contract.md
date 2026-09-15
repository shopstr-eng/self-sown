---
name: Square Apple Pay SDK contract
description: Square Web Payments SDK Apple Pay has no attach() — render your own button, tokenize() on click; reuse the server's minor-unit canonicalization for the wallet total.
---

Square Web Payments SDK Apple Pay contract (caught by adversarial review while mocked tests stayed green):

- There is **no `attach()`** on Apple Pay (unlike card, and unlike Square's Google Pay, which does use attach). Availability is `payments.applePay(paymentRequest)` resolving; you render the button yourself (WebKit `-apple-pay-button` appearance) and call `tokenize()` from its click handler. A mock that invents `attach()` keeps tests green while the real SDK silently no-ops into the catch.
- Build the wallet `total.amount` with the same minor-unit canonicalization the charge endpoint uses (here: `toSmallestUnit` — Math.ceil), or discounted fractional amounts can display less than what gets charged.
- If the charge path converts currency server-side at charge time (live FX for sats/BTC carts), a client-built wallet total can diverge from the charge — gate wallet payments to fiat carts.

**Why:** mocked SDK shapes can't catch contract drift (same trap as the Cashu API-drift guardrail), and rounding drift between wallet display and charge is a payment-correctness bug.

**How to apply:** any future Square wallet-method work — follow the pattern in the Square card form component and assert only real SDK methods in tests.
