---
name: Dynamic NIP-05 on custom domains
description: Why the custom-domain /.well-known/nostr.json endpoint resolves the seller from the domain (gated) instead of a supplied pubkey header.
---

# Dynamic NIP-05 (`/.well-known/nostr.json`) on seller custom domains

Custom-domain storefronts auto-serve a dynamic NIP-05 file mapping the seller's
kind:0 profile username -> their raw hex pubkey: `{"names":{"<name>":"<hex>"}}`.
The proxy intercepts `/.well-known/nostr.json` only inside the custom-domain
block (platform host keeps serving the static `public/.well-known/nostr.json`)
and rewrites to the API route, forwarding the real host via
`x-mm-custom-domain-host`.

**Rule:** The API route must resolve the owning seller FROM THE DOMAIN
(`x-mm-custom-domain-host` header, or `?domain=` fallback) against
`custom_domains WHERE verified=true`, then apply the `getMembershipView().isHidden`
gate — exactly like `/api/storefront/lookup`. It must NOT trust any
caller-supplied pubkey header (e.g. `x-mm-shop-pubkey`).

**Why:** `/api/storefront/nostr-json` is publicly reachable on its own, so a
direct caller can forge headers. Trusting a supplied pubkey lets a direct call
bypass the hidden/lapsed membership gate for any account. Resolving from the
verified domain makes the gate mandatory on both the proxied and direct paths.
Forging the host only ever returns that domain's already-public NIP-05, so it
grants no extra access. (Same family of bug as the spoofable `x-mm-self-host`
header — never trust a forgeable identity header for an authz decision.)

**How to apply:** Any new public endpoint that emits per-seller data keyed off a
custom domain must derive identity from the verified-domain lookup + membership
gate, never from a client header. Strip a `:port` suffix from the host before the
DB lookup.

**Deliberate tradeoff:** username is emitted verbatim plus a lower-cased alias
(NIP-05 clients commonly lower-case the local-part before querying); charset
normalization is intentionally NOT applied because the product requirement is to
expose the seller's exact profile `name`. A profile name with spaces/invalid
chars will simply not be a usable NIP-05 local-part — that's the seller's choice.
Always returns valid JSON (`{names:{}}` when nothing resolves), CORS `*`,
`no-store`.
