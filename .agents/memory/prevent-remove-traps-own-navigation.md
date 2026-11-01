---
name: usePreventRemove traps the screen's own navigation
description: React Navigation usePreventRemove blocks ALL removals of the screen — including the screen's own router.replace on success; arm a pass-through ref before intentional navigation.
---

`usePreventRemove(condition, cb)` (React Navigation 7) intercepts every action that removes the screen — not just back/gesture, but also the screen's own `router.replace(...)` to a success/next screen. If the callback doesn't dispatch `data.action`, the intentional navigation is silently swallowed.

**Why:** Found in the PoS card charge screen: blocking back-nav mid-charge also ate the post-payment `router.replace("/(tabs)/pos/success")`. The mocked-hook unit tests didn't catch it (the mock is a no-op); only reasoning through the event contract did.

**How to apply:** Pattern lives in `apps/mobile/hooks/use-listing-editor-navigation.ts` (`allow` ref) and `apps/mobile/app/(tabs)/pos/card.tsx` (`allowNavigationRef`): keep a ref, arm it right before the intentional navigation, and in the preventRemove callback dispatch `data.action` when armed. Also pair with `navigation.setOptions({ gestureEnabled: !blocked })` — usePreventRemove does not disable the iOS swipe-back gesture's visual start.
