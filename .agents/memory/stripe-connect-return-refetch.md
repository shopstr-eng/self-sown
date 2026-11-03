---
name: Connect return must refetch + poll status
description: After Stripe hosted onboarding returns to the mobile app, the dashboard must refetch status in the auth-session handler AND poll until charges_enabled flips — the deep-link route alone is not sufficient.
---

Two compounding traps when Stripe Connect hosted onboarding returns to the app:

1. `WebBrowser.openAuthSessionAsync` **consumes** the redirect URL when it matches the callback base — the `/stripe-connect-return` deep-link route (and its refetch effect) usually never fires. A return handler that defers refetching to the deep-link route leaves the dashboard showing the stale pre-connect status until a remount; sellers saw "Stripe not connected" right after finishing onboarding and tapped Connect a second time (re-answering the whole form).
2. Stripe flips `charges_enabled` **asynchronously** after onboarding completes, so even one immediate refetch can come back stale.

**Why:** a first-time connect appeared to "not take" until the seller re-did onboarding — pure client-side staleness, the account was fine.

**How to apply:** in any connect-return handler, always refetch status inline (never rely on the deep-link route), and use `refetchStripeConnectStatusUntilSettled` (apps/mobile/lib/stripe-connect.ts) which polls briefly until `chargesEnabled` confirms or the attempt budget runs out. Pass `{ attempts: 1 }` for "refresh" returns where charges can't be live yet. Fire `requestTerminalSdkInit()` only after charges confirm live.
