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

**Why:** the app must pass Apple's UX review to get the publishing entitlement (required even for TestFlight).
**How to apply:** when touching PoS card checkout, the awareness modal, or Settings tap-to-pay, keep these invariants; re-check the checklist PDF for new requirements when it revs.
