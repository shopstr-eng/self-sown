---
name: Post-payment redirect effect must not depend on router identity
description: Why the order-confirmed GIF looped instead of redirecting, and the ref-guard pattern that fixes timed navigation effects.
---

A `useEffect` that schedules a `setTimeout(() => router.push(...), N)` and lists
`router` (or any Next.js router object) in its dependency array will loop / never
fire: the router identity churns on nearly every render, so the effect re-runs,
its cleanup clears the pending timer, and a fresh timer is armed — resetting the
countdown indefinitely. Symptom seen here: the order-confirmed GIF played for
10s+ instead of ~2s then redirecting.

**Fix pattern (used in `product-listing-view.tsx` + `pages/cart/index.tsx`):**

- Read the router through a `routerRef` (`const routerRef = useRef(router); routerRef.current = router;`) and call `routerRef.current.push(...)` inside the timer — keep `router` OUT of the deps.
- Add a `redirectScheduledRef` boolean so the timer is scheduled exactly once.
- Reduce deps to the payment-success booleans only. Read any other values the
  timer needs (e.g. sessionStorage stall slug/pubkey) freshly inside the timer,
  not via deps.

**Why:** without this, dep churn re-arms the timer forever.

**How to apply / caveat:** the ref-guard + cleanup-that-clears combo is only safe
because the success flags (`invoiceIsPaid`, `cashuPaymentSent`,
`fiatOrderIsPlaced`) are mutually exclusive per checkout — exactly one flips true.
If a future flow ever flips two success flags in sequence, the deps change would
run cleanup (clearing the timer) and the ref-guard would block rescheduling,
suppressing the redirect entirely. Keep success flags mutually exclusive, or drop
the cleanup clear if that ever changes.
