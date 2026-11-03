---
name: Tap to Pay Apple review contract
description: Non-obvious constraints from Apple's Tap to Pay on iPhone UX checklist (v1.8) that the mobile PoS implementation depends on.
---

Apple's publishing entitlement review (checklist v1.8, attached*assets/Getting_Started_App_Requirements_and_Review*\*.pdf) imposes contracts that aren't obvious from the Stripe SDK:

- Never persist "Tap to Pay enabled" locally (Req 1.6) — T&C acceptance state belongs to Apple/the PSP. Only the awareness-moment-shown flag is stored (per seller pubkey).
- Enablement = the first `connectReader({ discoveryMethod: "tapToPay", tosAcceptancePermitted: true })`; the Stripe SDK presents Apple's Terms & Conditions natively. There is no separate T&C API. Any enable path (awareness modal, Settings, checkout) funnels through `enableTapToPay` in apps/mobile/lib/pos-tap-to-pay.ts.
- Warmup (Req 1.5/5.6) = a throwaway tapToPay `discoverReaders` + `cancelDiscovering`; single-flight module-wide, and checkout must `awaitPendingTapToPayWarmup()` before discovering or the two discoveries collide and error.
- The beta.34 RN `StripeTerminalProvider` NEVER auto-initializes: mounting it only exposes `initialize()` via context, and every hook method throws until a child calls it. `TapToPayProvider` (components/tap-to-pay-provider.tsx) renders an initializer child for this; anything firing early must also poll `getIsInitialized()`.
- The native SDK keeps the Tap to Pay connection alive across provider mounts. Enable paths and checkout must check `getConnectedReader()` first and reuse the live connection — a fresh discovery against a connected reader errors.
- Checkout payment list: Tap to Pay first, never disabled/hidden for eligible sellers (5.2/5.3); eligibility = module shipped + Stripe chargesEnabled + `supportsReadersOfType` device probe.
- Merchant education (4.2-4.8) uses CUSTOM screens, not Apple's ProximityReaderDiscovery API (4.1): the Stripe Terminal RN SDK (beta.34) doesn't expose it and a native Expo module for education alone is disproportionate; Apple's 4.4 conditional path allows custom screens from Marketing Guide/Toolkit copy — never self-made iPhone imagery. Screens open once after any T&C acceptance point (awareness, Settings, first checkout connect — checkout pauses the sale on a resolver), keyed per-pubkey in AsyncStorage, reopenable from Settings > Tap to Pay.

- On device, "First initialize the Stripe Terminal SDK before performing any action" usually means the tokenProvider fetch failed, not an SDK bug: beta.34's initialize awaits tokenProvider() before native init, so a 404/403 on /api/stripe/terminal/connection-token leaves the SDK permanently uninitialized and EVERY later action throws that misleading error. First check: `curl -X POST https://self-sown.com/api/stripe/terminal/connection-token` — 404 = deployed app predates the Terminal endpoints (publish fixes it), 401/403 = auth or Connect-account state. Device logs do NOT stream to Metro over a cloudflared tunnel, so diagnose from the server side.
- That raw init error must NEVER reach sellers: every Tap to Pay enable failure funnels through describeTapToPayEnableFailure (pos-tap-to-pay.ts), which maps stripe_not_connected (PosApiError.code from posPost) and the swallowed-403 init error — re-checked via fetchPosPaymentMethods — to "Connect a Stripe account with card charges to use Tap to Pay." Any new enable/charge surface must use it too (PoS card checkout still doesn't — follow-up).

**Why:** the app must pass Apple's UX review to get the publishing entitlement (required even for TestFlight).
**How to apply:** when touching PoS card checkout, the awareness modal, or Settings tap-to-pay, keep these invariants; re-check the checklist PDF for new requirements when it revs.
