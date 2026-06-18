---
name: Self-host header trust must be env-gated
description: Why the x-mm-self-host signal can never be trusted from the header alone; how forceSelfHostChrome is kept fail-closed on the hosted platform.
---

# Self-host header trust must be env-gated (fail-closed)

The `x-mm-self-host` request header is set by `proxy.ts` only on a real
self-host deployment, but it is a **client-spoofable inbound header** on the
hosted platform. Anything that flips behavior off this header must ALSO require
the server process to genuinely be in self-host mode (`MM_SELF_HOST` env).

`pages/_app.tsx` `getInitialProps` computes `__isSelfHostSsr` via the pure
helper `selfHostHeaderTrusted(process.env.MM_SELF_HOST, header)` in
`utils/self-host/routing.ts` (truthiness mirrors `truthyEnv` in
`utils/self-host/config.ts`: `1/true/yes/on`). `__isSelfHostSsr` drives
`forceSelfHostChrome`, and `StorefrontThemeWrapper` does
`entitled = forceSelfHostChrome || sellerIsPro`.

**Why:** if `__isSelfHostSsr` were set from the header alone, a crafted
`x-mm-self-host: 1` on the hosted platform would set `forceSelfHostChrome` and
bypass the render-layer Pro gate — serving a non-Pro seller's branded chrome.
The render layer is the only enforcement for storefront chrome (the design is
published to Nostr, no server write path to gate), so this gate being spoofable
is a real Pro-feature bypass.

**How to apply:** never trust `x-mm-self-host` (or any proxy-injected `x-mm-*`
routing header) from the header alone in code that runs in the hosted app. Gate
it on the server-side `MM_SELF_HOST` env too. Keep the trust decision in the
import-free `routing.ts` so `_app.tsx` (bundled for the client) can share it
without pulling in the server-only `config.ts`. Read the env directly in
`getInitialProps` — do NOT import `config.ts` into `_app.tsx`.
